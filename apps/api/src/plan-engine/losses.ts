/**
 * Where the page loses people, measured in code before any model. Each loss is
 * "absolute" (limit only), "device" (worse on one device) or "segment" (a
 * channel or new x returning converts worse than the rest).
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
  /** "L1", "L2"... - this is what the model picks by. */
  id: string;
  key: UxMetricKey;
  control: LossControl;
  device: UxDevice;
  /** The other device, only on the device loss. */
  compare_to: UxDevice | null;
  segment: SegmentRef | null;
  /** The stage on the device (with the comparison, on the device loss). */
  measured: MeasuredMetric;
  /** The segment against the rest. Only on the segment loss. */
  premise: SegmentPremise | null;
  /** The loss in pp: the gap (device), distance to the rest (segment) or the stage drop (absolute). */
  loss_pp: number;
  /** People who did not get through because of the loss, in the window. */
  lost: number;
  /** The loss in one sentence, with the numbers. It is the opportunity title. */
  title: string;
}

/** How many segment losses per stage and device (the largest ones). */
const MAX_SEGMENT_LOSSES = 2;

/** The segment must convert at most this share of the rest to be a loss of its own. */
const SEGMENT_MAX_RATIO = 0.85;

/** Cuts that are not an audience: classification leftovers. */
const NOT_A_SEGMENT = new Set(["outros", "sem_dado"]);

const DEVICE_WORD: Record<UxDevice, string> = {
  mobile: "celular",
  desktop: "computador",
};

const OTHER: Record<UxDevice, UxDevice> = {
  mobile: "desktop",
  desktop: "mobile",
};

/** Who is in the stage, what passing is, what not passing is - for the sentence. */
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

/** The stage sentences; the route is included when the page has one (category, search). */
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

/** Is the difference outside the 95% interval? */
function beyondNoise(a: number, na: number, b: number, nb: number): boolean {
  const se = Math.sqrt((a * (1 - a)) / na + (b * (1 - b)) / nb);
  return Math.abs(a - b) > 1.96 * se;
}

const ROUTED: UxPageType[] = ["home", "categoria", "busca"];

/** The analyzed page's losses, in stable order (stage, device, kind). Exported for tests. */
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

/** The segments that convert worse than the rest, on the same device. */
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

/** A sentence about the comparison type, for hypotheses, review and dossier. */
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
