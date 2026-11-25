/**
 * Onde a página perde gente — medido em código, antes de qualquer modelo.
 *
 * Até 16/11 a oportunidade era escrita pelo modelo: um título livre e uma
 * etapa do funil escolhida de uma lista. O título saía como CAUSA ("o card não
 * mostra desconto numa página 100% promoção"), a etapa era do site inteiro e
 * com o sinal trocado (o celular clicava MAIS que o computador), e as
 * hipóteses, escritas pra etapa e não pro título, falavam de outra coisa (o
 * filtro que não fica fixo). Nada no código ligava as três.
 *
 * Agora a oportunidade é uma destas perdas, escolhida em código
 * (loss-opportunities.ts): só as com comparação, com a mistura de público
 * descontada. Três jeitos de medir uma perda, e cada um decide o que é causa:
 *
 * - "absoluta": quanto da etapa se perde num dispositivo, sem comparação. Não
 *   vira oportunidade (não diz se a perda é grande); fica como limite.
 * - "dispositivo": a etapa é pior num dispositivo que no outro, fora do ruído.
 *   Só explica uma causa que MUDA entre as telas.
 * - "segmento": um canal (ou nova × recorrente) converte pior que o resto, no
 *   mesmo dispositivo. Só explica uma causa que pesa MAIS nele.
 */

import {
  type LossControl,
  type MeasuredMetric,
  measureMetric,
  pageScopedMetrics,
  type SegmentRef,
  UX_METRICS,
  type UxMetricKey,
} from "./metrics.ts";
import { MIN_SAMPLE, SEGMENT_WORD } from "./reliability.ts";
import { type SegmentPremise, segmentPremise } from "./segments.ts";
import type { DiagnosisEvidence, UxDevice, UxPageType } from "./types.ts";

export interface MeasuredLoss {
  /** "L1", "L2"… — é por isto que o modelo escolhe. */
  id: string;
  key: UxMetricKey;
  control: LossControl;
  device: UxDevice;
  /** O outro dispositivo, só na perda de dispositivo. */
  compare_to: UxDevice | null;
  segment: SegmentRef | null;
  /** A etapa no dispositivo (com a comparação, na perda de dispositivo). */
  measured: MeasuredMetric;
  /** O segmento contra o resto. Só na perda de segmento. */
  premise: SegmentPremise | null;
  /**
   * A perda em pp: o gap (dispositivo), a distância pro resto (segmento) ou
   * quanto não passa da etapa (absoluta).
   */
  loss_pp: number;
  /** Pessoas que não passaram por causa da perda, na janela. */
  lost: number;
  /** A perda numa frase, com os números. É o título da oportunidade. */
  title: string;
}

/** Quantas perdas de segmento por etapa e dispositivo (as maiores). */
const MAX_SEGMENT_LOSSES = 2;

/**
 * O segmento converte no máximo isto do resto pra ser uma perda dele. Numa loja de moda
 * (16/11) o checkout tinha 30 recortes "fora do ruído" com 1–2 pp de
 * distância: amostra grande deixa tudo significativo, e nada disso é um
 * problema de canal.
 */
const SEGMENT_MAX_RATIO = 0.85;

/** Recortes que não são um público: sobra de classificação. */
const NOT_A_SEGMENT = new Set(["outros", "sem_dado"]);

const DEVICE_WORD: Record<UxDevice, string> = {
  mobile: "celular",
  desktop: "computador",
};

const OTHER: Record<UxDevice, UxDevice> = {
  mobile: "desktop",
  desktop: "mobile",
};

/** Quem está na etapa, o que é passar, o que é não passar — pra frase. */
const PHRASES: Partial<
  Record<UxMetricKey, { who: string; pass: string; miss: string }>
> = {
  pagina_produto: {
    who: "entra na página",
    pass: "abre um produto",
    miss: "não abre nenhum produto",
  },
  pagina_carrinho: {
    who: "entra na página",
    pass: "põe algo no carrinho",
    miss: "não põe nada no carrinho",
  },
  produto_carrinho: {
    who: "vê um produto",
    pass: "põe no carrinho",
    miss: "não põe no carrinho",
  },
  pdp_carrinho: {
    who: "vê um produto",
    pass: "põe no carrinho",
    miss: "não põe no carrinho",
  },
  vercarrinho_checkout: {
    who: "abre o carrinho",
    pass: "começa o checkout",
    miss: "não começa o checkout",
  },
  carrinho_checkout: {
    who: "põe no carrinho",
    pass: "começa o checkout",
    miss: "não começa o checkout",
  },
  checkout_frete: {
    who: "começa o checkout",
    pass: "informa a entrega",
    miss: "não informa a entrega",
  },
  frete_pagamento: {
    who: "informa a entrega",
    pass: "informa o pagamento",
    miss: "não informa o pagamento",
  },
  pagamento_compra: {
    who: "informa o pagamento",
    pass: "finaliza a compra",
    miss: "não finaliza a compra",
  },
  checkout_compra: {
    who: "começa o checkout",
    pass: "finaliza a compra",
    miss: "não finaliza a compra",
  },
};

const pct = (r: number) =>
  `${(r * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

/** As frases da etapa; a rota entra quando a página tem uma (categoria, busca). */
function phrases(key: UxMetricKey, route: string | null) {
  const p = PHRASES[key];
  if (!p) {
    const [from, to] = UX_METRICS[key].label.split(" → ");
    return {
      who: `chega em "${from}"`,
      pass: `chega em "${to}"`,
      miss: `não chega em "${to}"`,
    };
  }
  return route && p.who === "entra na página"
    ? { ...p, who: `entra em ${route}` }
    : p;
}

/** A diferença está fora do intervalo de 95%? */
function beyondNoise(a: number, na: number, b: number, nb: number): boolean {
  const se = Math.sqrt((a * (1 - a)) / na + (b * (1 - b)) / nb);
  return Math.abs(a - b) > 1.96 * se;
}

const ROUTED: UxPageType[] = ["home", "categoria", "busca"];

/**
 * As perdas da página analisada, nas etapas que medem a página (não o site).
 * Ordem estável: etapa, dispositivo (celular primeiro), absoluta, dispositivo,
 * segmento. Exportado pra teste.
 */
export function findLosses(evidence: DiagnosisEvidence): MeasuredLoss[] {
  const pageType = evidence.page_type ?? "pdp";
  const route =
    ROUTED.includes(pageType) &&
    evidence.page_route &&
    evidence.page_route !== "/"
      ? evidence.page_route
      : pageType === "home"
        ? "na home"
        : null;
  const out: Array<Omit<MeasuredLoss, "id">> = [];
  for (const key of pageScopedMetrics(pageType)) {
    for (const device of ["mobile", "desktop"] as const) {
      const abs = measureMetric(
        evidence,
        { key, device, compare_to: null },
        pageType,
      );
      if (!abs || abs.n < MIN_SAMPLE) continue;
      const ph = phrases(abs.key, route === "na home" ? null : route);
      const where = route === "na home" ? " na home" : "";
      const word = DEVICE_WORD[device];

      out.push({
        key: abs.key,
        control: "absoluta",
        device,
        compare_to: null,
        segment: null,
        measured: abs,
        premise: null,
        loss_pp: round2((1 - abs.rate) * 100),
        lost: Math.round(abs.n - abs.hits),
        title: `No ${word}, ${pct(1 - abs.rate)} de quem ${ph.who}${where} ${ph.miss}`,
      });

      const other = OTHER[device];
      const dev = measureMetric(
        evidence,
        { key, device, compare_to: other },
        pageType,
      );
      if (
        dev?.comp &&
        dev.gap_pp != null &&
        dev.gap_pp > 0 &&
        dev.comp.n >= MIN_SAMPLE &&
        beyondNoise(dev.rate, dev.n, dev.comp.rate, dev.comp.n)
      ) {
        out.push({
          key: dev.key,
          control: "dispositivo",
          device,
          compare_to: other,
          segment: null,
          measured: dev,
          premise: null,
          loss_pp: dev.gap_pp,
          lost: Math.round((dev.n * dev.gap_pp) / 100),
          title: `No ${word}, ${pct(dev.rate)} de quem ${ph.who}${where} ${ph.pass}; no ${DEVICE_WORD[other]}, ${pct(dev.comp.rate)}`,
        });
      }

      out.push(...segmentLosses(evidence, abs, ph, where));
    }
  }
  return out.map((l, i) => ({ ...l, id: `L${i + 1}` }));
}

/** Os segmentos que convertem pior que o resto, no mesmo dispositivo. */
function segmentLosses(
  evidence: DiagnosisEvidence,
  abs: MeasuredMetric,
  ph: { who: string; pass: string },
  where: string,
): Array<Omit<MeasuredLoss, "id">> {
  const def = UX_METRICS[abs.key];
  if (def.source !== "ga4" || !evidence.segments?.length) return [];
  const keys = new Map<string, "canal" | "visitante">();
  for (const s of evidence.segments) {
    if (s.dim === "canal" || s.dim === "visitante") keys.set(s.key, s.dim);
  }
  const found: Array<Omit<MeasuredLoss, "id">> = [];
  for (const [key, dim] of keys) {
    if (NOT_A_SEGMENT.has(key)) continue;
    const p = segmentPremise(
      abs,
      evidence.segments,
      { dim, key },
      OTHER[abs.device],
    );
    if (!p || p.n < MIN_SAMPLE || p.rest_n < MIN_SAMPLE) continue;
    if (p.rate > p.rest_rate * SEGMENT_MAX_RATIO) continue;
    if (!beyondNoise(p.rate, p.n, p.rest_rate, p.rest_n)) continue;
    const lossPp = round2((p.rest_rate - p.rate) * 100);
    const name = SEGMENT_WORD[key] ?? key;
    const rest = dim === "canal" ? "dos outros canais" : "do resto";
    found.push({
      key: abs.key,
      control: "segmento",
      device: abs.device,
      compare_to: null,
      segment: { dim, key },
      measured: abs,
      premise: p,
      loss_pp: lossPp,
      lost: Math.round((p.n * lossPp) / 100),
      title: `${capitalize(name)} no ${DEVICE_WORD[abs.device]}: ${pct(p.rate)} de quem ${ph.who}${where} ${ph.pass}, contra ${pct(p.rest_rate)} ${rest}`,
    });
  }
  return found.sort((a, b) => b.lost - a.lost).slice(0, MAX_SEGMENT_LOSSES);
}

/** Uma frase sobre o tipo de comparação, pra hipóteses, revisão e dossiê. */
export function controlNote(
  control: LossControl | undefined,
  segmentKey?: string | null,
): string {
  if (control === "dispositivo") {
    return "A perda é a diferença entre celular e computador: só explica uma causa que muda entre as telas.";
  }
  if (control === "segmento") {
    const name = segmentKey
      ? (SEGMENT_WORD[segmentKey] ?? segmentKey)
      : "o segmento";
    return `A perda é ${name} contra o resto, no mesmo dispositivo: só explica uma causa que pesa mais em ${name}.`;
  }
  if (control === "absoluta") {
    return 'A perda é absoluta (quanto não passa da etapa), sem comparação: uma causa que vale pras duas telas explica, e "é igual no outro dispositivo" NÃO derruba a hipótese.';
  }
  return "";
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const round2 = (v: number) => Math.round(v * 100) / 100;
