/**
 * Checagem só de dados — pra hipótese que não se confere na página.
 *
 * "O celular recebe mais tráfego de campanha, que converte menos em qualquer
 * tela" não tem botão pra inspecionar: quem decide é o gap ajustado pela
 * mistura de canais (segments.ts). Se o gap some com a mistura do outro
 * dispositivo, a explicação se sustenta; se quase nada some e o gap se repete
 * canal a canal, ela cai. Sem modelo e sem navegador.
 */

import { SEGMENT_WORD } from "./reliability.ts";
import {
  type FunnelSegmentList,
  mixExplainedShare,
  segmentPremise,
} from "./segments.ts";
import type { UxHypothesis, UxOpportunity } from "./types.ts";
import type { CheckRun, HypothesisVerification } from "./verify/types.ts";

/** No outro dispositivo, abaixo disso do resto = o segmento converte menos lá também. */
const SEGMENT_WORSE = 0.85;
/** No outro dispositivo, a partir disso do resto = converte igual. */
const SEGMENT_SAME = 0.95;

const DEVICE_WORD = { mobile: "celular", desktop: "computador" } as const;

/** Troca o que o teste afirma pela pergunta do segmento. */
function withCheck(
  v: HypothesisVerification,
  claim: string,
): HypothesisVerification {
  return {
    ...v,
    runs: v.runs.map((r) => ({
      ...r,
      check: {
        ...r.check,
        claim,
        confirms_if:
          "o segmento converte menos que o resto também no outro dispositivo",
        refutes_if: "no outro dispositivo o segmento converte como o resto",
      },
    })),
  };
}

/** A partir daqui o mix explica a maior parte do gap. */
const EXPLAINS = 0.5;
/** Abaixo disso o mix quase não explica. */
const BARELY = 0.2;

const pp = (v: number) =>
  `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} pp`;

/** Hipótese que esta checagem sabe decidir. */
export const isDataCheckable = (h: Pick<UxHypothesis, "tree">) =>
  h.tree?.category === "trafego" && h.tree.testavel_na_pagina === false;

export function trafficCheck(
  h: Pick<UxHypothesis, "device" | "confidence" | "verification">,
  opportunity: Pick<UxOpportunity, "drilldown" | "metric" | "measured">,
  now: string,
  /** Os recortes do GA4 (evidence.segments), pra oportunidade de um segmento. */
  segments?: FunnelSegmentList,
): HypothesisVerification {
  const d = opportunity.drilldown;
  const device: "mobile" | "desktop" =
    h.device === "desktop" ? "desktop" : "mobile";
  const check = {
    id: "d1",
    claim: "o gap vem da mistura de tráfego, não da página",
    stage: "data" as const,
    device,
    steps: [],
    question: null,
    confirms_if: `com a mistura de tráfego do outro dispositivo, ao menos ${EXPLAINS * 100}% do gap some`,
    refutes_if: `menos de ${BARELY * 100}% do gap some e ele aparece em 2 de cada 3 canais`,
  };
  const base = h.verification?.base_confidence ?? h.confidence;
  const result = (
    outcome: CheckRun["outcome"],
    observed: string,
  ): HypothesisVerification => {
    const verdict =
      outcome === "confirma"
        ? "confirmada"
        : outcome === "desmente"
          ? "desmentida"
          : "inconclusiva";
    return {
      verdict,
      summary:
        verdict === "inconclusiva"
          ? `Os recortes não decidem: ${observed}`
          : `${verdict === "confirmada" ? "Confirmada" : "Desmentida"} pelos recortes do GA4: ${observed}`,
      runs: [
        { check, outcome, observed, screenshot_url: null, source_ref: null },
      ],
      rewritten_from: null,
      verified_at: now,
      base_confidence: base,
      ...(verdict === "desmentida"
        ? {
            novas_linhas: [
              "O gap se repete dentro de cada canal: procurar a causa na página ou no fluxo, não no tráfego.",
            ],
          }
        : {}),
    };
  };
  // Oportunidade de um segmento: "esse canal traz gente de baixa intenção"
  // se decide comparando o segmento com o resto nas DUAS telas. Em 16/11
  // (numa loja de moda) a oportunidade de social pago não tinha comparação de
  // tela, a checagem só sabia usar o mix, e a hipótese ficou "bloqueada".
  const seg = opportunity.metric?.segment;
  const p = seg
    ? segmentPremise(
        opportunity.measured,
        segments,
        seg,
        device === "mobile" ? "desktop" : "mobile",
      )
    : null;
  if (p && p.comp_rate != null && p.comp_rest_rate != null && p.comp_device) {
    const name = SEGMENT_WORD[p.key] ?? p.key;
    const pc = (v: number) =>
      `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
    const here = DEVICE_WORD[p.device];
    const there = DEVICE_WORD[p.comp_device];
    const observed = `${name}: ${pc(p.rate)} no ${here} contra ${pc(p.rest_rate)} do resto; no ${there}, ${pc(p.comp_rate)} contra ${pc(p.comp_rest_rate)}.`;
    const worseHere = p.rate < p.rest_rate;
    const worseThere = p.comp_rate < p.comp_rest_rate * SEGMENT_WORSE;
    if (worseHere && worseThere) {
      return withCheck(
        result(
          "confirma",
          `${observed} Converte menos nas duas telas: é o tráfego.`,
        ),
        `${name} converte menos que o resto nas duas telas`,
      );
    }
    if (p.comp_rate >= p.comp_rest_rate * SEGMENT_SAME) {
      const out = withCheck(
        result(
          "desmente",
          `${observed} No ${there} ${name} converte como o resto: não é a intenção do tráfego, é a experiência no ${here}.`,
        ),
        `${name} converte menos que o resto nas duas telas`,
      );
      return {
        ...out,
        novas_linhas: [
          `No ${there} ${name} converte como o resto: procurar o que a página do ${here} faz diferente pra quem chega por ${name} (página de destino, produto do anúncio, pop-up, velocidade).`,
        ],
      };
    }
    return withCheck(
      result("nao_decidiu", observed),
      `${name} converte menos que o resto nas duas telas`,
    );
  }
  if (!d) {
    return result(
      "nao_testou",
      "sem recortes do GA4 nesta análise (a etapa não é do GA4, não há comparação, ou a consulta falhou).",
    );
  }
  const mix = mixExplainedShare(d);
  if (!mix) return result("nao_testou", "o gap é zero: não há o que explicar.");
  const adj = d.mix_adjusted_gap_pp[mix.dim] ?? d.gap_pp;
  const share = Math.round(mix.share * 100);
  const channels = d.consistency.canal;
  const observed = `com a mistura ${mix.dim === "canal" ? "de canais" : "de nova × recorrente"} do outro dispositivo, o gap vai de ${pp(d.gap_pp)} para ${pp(adj)} (${share}% explicado)${channels ? `; o gap aparece em ${channels.same} de ${channels.total} canais` : ""}.`;
  if (mix.share >= EXPLAINS) return result("confirma", observed);
  const repeats = channels ? channels.same / channels.total >= 2 / 3 : false;
  if (mix.share < BARELY && repeats) return result("desmente", observed);
  return result("nao_decidiu", observed);
}
