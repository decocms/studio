/**
 * Data-only check for hypotheses that cannot be verified on the page: the
 * decider is the gap adjusted for the channel mix (segments.ts). No model, no browser.
 * A segment comparison decides only beyond sampling noise, one-sided at 5%:
 * a small segment that merely looks worse, or merely looks the same, stays
 * undecided instead of confirming or refuting a cause.
 */

import { SEGMENT_WORD } from "./reliability.ts";
import {
  type FunnelSegmentList,
  mixExplainedShare,
  segmentPremise,
} from "./segments.ts";
import type { UxHypothesis, UxOpportunity } from "./types.ts";
import type { CheckRun, HypothesisVerification } from "./verify/types.ts";

/** On the other device, below this share of the rest = the segment converts less there too. */
const SEGMENT_WORSE = 0.85;
/** On the other device, from this share of the rest = converts the same. */
const SEGMENT_SAME = 0.95;

const DEVICE_WORD = { mobile: "celular", desktop: "computador" } as const;

/** One-sided z at α = 5%. */
const Z_ONE_SIDED = 1.644854;

/**
 * Where rate `a` (of `na`) sits against `ratio × b` (of `nb`), in standard
 * errors: below −Z_ONE_SIDED it is lower beyond noise, above Z_ONE_SIDED higher.
 * Exported for tests.
 */
export function zAgainst(
  a: number,
  na: number,
  b: number,
  nb: number,
  ratio = 1,
): number {
  const se = Math.sqrt(
    (a * (1 - a)) / na + (ratio * ratio * (b * (1 - b))) / nb,
  );
  const diff = a - ratio * b;
  if (se > 0) return diff / se;
  return diff === 0 ? 0 : diff > 0 ? Infinity : -Infinity;
}

/** Replaces what the test asserts with the segment question. */
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

/** From here the mix explains most of the gap. */
const EXPLAINS = 0.5;
/** Below this the mix barely explains it. */
const BARELY = 0.2;

const int = (v: number) => v.toLocaleString("pt-BR");

const pp = (v: number) =>
  `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} pp`;

/** A hypothesis this check knows how to decide. */
export const isDataCheckable = (h: Pick<UxHypothesis, "tree">) =>
  h.tree?.category === "trafego" && h.tree.testavel_na_pagina === false;

export function trafficCheck(
  h: Pick<UxHypothesis, "device" | "confidence" | "verification">,
  opportunity: Pick<UxOpportunity, "drilldown" | "metric" | "measured">,
  now: string,
  /** GA4 cuts (evidence.segments), for a segment opportunity. */
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
  // A segment opportunity is decided by comparing the segment with the rest on BOTH screens, not only by the mix.
  const seg = opportunity.metric?.segment;
  const p = seg
    ? segmentPremise(
        opportunity.measured,
        segments,
        seg,
        device === "mobile" ? "desktop" : "mobile",
      )
    : null;
  if (
    p &&
    p.comp_rate != null &&
    p.comp_rest_rate != null &&
    p.comp_n &&
    p.comp_rest_n &&
    p.comp_device
  ) {
    const name = SEGMENT_WORD[p.key] ?? p.key;
    const pc = (v: number) =>
      `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
    const here = DEVICE_WORD[p.device];
    const there = DEVICE_WORD[p.comp_device];
    const observed = `${name}: ${pc(p.rate)} no ${here} contra ${pc(p.rest_rate)} do resto; no ${there}, ${pc(p.comp_rate)} contra ${pc(p.comp_rest_rate)}.`;
    const worseHere =
      zAgainst(p.rate, p.n, p.rest_rate, p.rest_n) < -Z_ONE_SIDED;
    const zThere = zAgainst(
      p.comp_rate,
      p.comp_n,
      p.comp_rest_rate,
      p.comp_rest_n,
    );
    const worseThere =
      p.comp_rate < p.comp_rest_rate * SEGMENT_WORSE && zThere < -Z_ONE_SIDED;
    // "Converts like the rest" needs the "worse" zone ruled out, not just a close number.
    const outOfWorse =
      zAgainst(
        p.comp_rate,
        p.comp_n,
        p.comp_rest_rate,
        p.comp_rest_n,
        SEGMENT_WORSE,
      ) > Z_ONE_SIDED;
    if (worseHere && worseThere) {
      return withCheck(
        result(
          "confirma",
          `${observed} Converte menos nas duas telas: é o tráfego.`,
        ),
        `${name} converte menos que o resto nas duas telas`,
      );
    }
    if (p.comp_rate >= p.comp_rest_rate * SEGMENT_SAME && outOfWorse) {
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
    // The numbers point one way but the sample cannot tell: say so, not "in between".
    const looked =
      p.rate < p.rest_rate &&
      (p.comp_rate < p.comp_rest_rate * SEGMENT_WORSE ||
        p.comp_rate >= p.comp_rest_rate * SEGMENT_SAME);
    return withCheck(
      result(
        "nao_decidiu",
        looked
          ? `${observed} Com ${int(p.n)} × ${int(p.rest_n)} no ${here} e ${int(p.comp_n)} × ${int(p.comp_rest_n)} no ${there}, a diferença não sai do ruído da amostra.`
          : observed,
      ),
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
