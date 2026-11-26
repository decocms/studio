/**
 * Which hypotheses deserve attention: INVESTIGATION priority (impact, reach and
 * uncertainty) and TEST priority (impact, confidence, reach, measurability,
 * minus effort and risk; ready hypotheses only). Confidence is evidence
 * quality, not the model's, capped at 0.9: a cause is never proven before the A/B.
 */

import type { UxClaimLabel } from "./claims.ts";
import type { ExperimentDesign } from "./experiment.ts";
import type { KnowledgeEntry, KnowledgeSourceType } from "./knowledge/types.ts";
import type { HypothesisRelevance } from "./relevance.ts";
import type {
  DiagnosisEvidence,
  UxHypothesis,
  UxOpportunity,
} from "./types.ts";

const CLAIM_WEIGHT: Record<UxClaimLabel, number> = {
  fato_observado: 0.5,
  evidencia_indireta: 0.15,
  inferencia: 0.05,
  hipotese: 0.05,
  conclusao_experimental: 0.6,
};

const KNOWLEDGE_WEIGHT: Record<KnowledgeSourceType, number> = {
  ab_desta_loja: 0.6,
  veredito_desta_loja: 0.4,
  estudo: 0.35,
  ab_outra_loja: 0.25,
  benchmark: 0.15,
  boa_pratica: 0.15,
  opiniao: 0.05,
};

const EFFORT_FACTOR = { 1: 1, 2: 0.6, 3: 0.35 } as const;
export const CONFIDENCE_CEILING = 0.9;

export interface HypothesisPriority {
  impacto: number;
  confianca: number;
  abrangencia: number;
  esforco: number;
  risco: number;
  mensurabilidade: number;
  /** 0-1. How much it is worth investigating now. */
  investigacao: number;
  /** 0-1, only for test-ready. NULL = cannot be tested yet. */
  teste: number | null;
  /** How each factor came out, in words. */
  notas: string[];
}

/** 1 − Π(1 − wᵢ): adds independent evidence without exceeding 1. */
const combine = (weights: number[]) =>
  1 - weights.reduce((acc, w) => acc * (1 - w), 1);

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Impact reference value: 10% of measured monthly revenue (all channels). */
export function referenceValue(
  evidence: DiagnosisEvidence,
  opportunities: Pick<UxOpportunity, "money">[],
): number {
  const r = evidence.revenue;
  if (r && r.window_days > 0) {
    const monthly =
      (r.by_channel.reduce((a, c) => a + c.revenue, 0) * 30) / r.window_days;
    if (monthly > 0) return monthly * 0.1;
  }
  const max = Math.max(
    0,
    ...opportunities.map((o) => o.money?.monthly_value ?? 0),
  );
  return max > 0 ? max : 1;
}

export function priorityOf(input: {
  hypothesis: Pick<
    UxHypothesis,
    "tree" | "validation" | "device" | "lifecycle"
  >;
  opportunity: Pick<UxOpportunity, "money" | "area">;
  relevance: HypothesisRelevance | null | undefined;
  experiment: ExperimentDesign | null;
  evidence: DiagnosisEvidence;
  knowledge: Map<string, KnowledgeEntry>;
  referenceValue: number;
  ready: boolean;
  /** The round's goal: context for the notes, never part of the calculation. */
  objective?: string | null;
}): HypothesisPriority {
  const { hypothesis: h, opportunity: o } = input;
  const notas: string[] = [];
  const goal = input.objective?.trim();
  if (goal) notas.push(`meta da rodada: ${goal}`);
  const tree = h.tree ?? null;

  // Impact: the OPPORTUNITY's value (counted once), on a log scale.
  const v = o.money?.monthly_value ?? 0;
  const impacto =
    v > 0
      ? Math.min(1, Math.log10(1 + v) / Math.log10(1 + input.referenceValue))
      : 0.2;
  notas.push(
    v > 0
      ? `impacto pelo valor da oportunidade contra 10% da receita mensal`
      : "oportunidade sem conta de dinheiro: impacto mínimo",
  );

  // Confidence from evidence quality.
  const favor = (tree?.a_favor ?? []).map((c) => CLAIM_WEIGHT[c.label]);
  const against = (tree?.contra ?? []).map((c) => CLAIM_WEIGHT[c.label]);
  const cited = (tree?.fontes_conhecimento ?? [])
    .map((id) => input.knowledge.get(id))
    .filter((e): e is KnowledgeEntry => Boolean(e));
  for (const e of cited) {
    const w = KNOWLEDGE_WEIGHT[e.tipo_fonte];
    const negative = e.resultado === "negativo" || e.resultado === "refutada";
    (negative ? against : favor).push(w);
  }
  let confianca = 0.2 + 0.6 * combine(favor) - 0.5 * combine(against);
  const val = h.validation;
  if (val?.existencia === "confirmada") confianca += 0.1;
  if (val?.implementacao === "confirmada") confianca += 0.1;
  if (val?.relevancia === "alta" || val?.relevancia === "media")
    confianca += 0.1;
  confianca = Math.min(CONFIDENCE_CEILING, Math.max(0, confianca));
  notas.push(
    `confiança: ${favor.length} a favor, ${against.length} contra, níveis confirmados somam`,
  );

  // Reach: who the change affects × the device share.
  const devices = input.evidence.pdp_behaviour;
  const total = devices.reduce((a, b) => a + b.views, 0);
  const mine = devices.find(
    (b) => b.device === (h.device === "desktop" ? "desktop" : "mobile"),
  );
  const deviceShare = total > 0 && mine ? mine.views / total : 1;
  const affected = (input.relevance?.affected_pct ?? 100) / 100;
  const abrangencia = Math.min(1, affected * deviceShare);

  const esforco = EFFORT_FACTOR[tree?.esforco ?? 2];
  // Risk: touching the buy button or checkout can hurt sales; so can an A/B here that lost on the same part.
  const lostHere = [...input.knowledge.values()].some(
    (e) =>
      e.tipo_fonte === "ab_desta_loja" &&
      e.resultado === "negativo" &&
      e.areas.includes(o.area),
  );
  const risco = lostHere
    ? 0.5
    : o.area === "botao_compra" ||
        o.area === "carrinho_checkout" ||
        o.area === "carrinho" ||
        o.area === "checkout"
      ? 0.75
      : 1;
  if (lostHere) notas.push("um A/B desta loja já perdeu nesta parte da página");

  const weeks = input.experiment?.weeks ?? -1;
  const mensurabilidade =
    weeks > 0 && weeks <= 4 ? 1 : weeks > 0 && weeks <= 8 ? 0.6 : 0;

  const testable = tree?.testavel_na_pagina !== false;
  const investigacao =
    impacto * abrangencia * (1 - confianca) * (testable ? 1 : 0.3);
  const teste = input.ready
    ? impacto * confianca * abrangencia * mensurabilidade * esforco * risco
    : null;
  return {
    impacto: round2(impacto),
    confianca: round2(confianca),
    abrangencia: round2(abrangencia),
    esforco,
    risco,
    mensurabilidade,
    investigacao: round2(investigacao),
    teste: teste === null ? null : round2(teste),
    notas,
  };
}

/** Test-ready: at least medium relevance, a test measurable with today's traffic, and no blocker in the opportunity data. */
export function isReady(input: {
  relevance: HypothesisRelevance | null | undefined;
  experiment: ExperimentDesign | null;
  opportunity: Pick<UxOpportunity, "reliability">;
}): { ready: boolean; why: string } {
  if (!input.relevance) return { ready: false, why: "relevância não medida" };
  if (
    input.relevance.level === "baixa" ||
    input.relevance.level === "sem_relevancia"
  ) {
    return {
      ready: false,
      why: `relevância ${input.relevance.level.replace("_", " ")}`,
    };
  }
  if (!input.experiment)
    return { ready: false, why: "sem linha de base pra métrica" };
  if (!input.experiment.measurable) {
    return {
      ready: false,
      why: "o teste não fecha em 8 semanas com este tráfego",
    };
  }
  if (input.opportunity.reliability?.level === "baixa") {
    return { ready: false, why: "os dados da oportunidade são frágeis" };
  }
  return { ready: true, why: "relevante, mensurável e com dados confiáveis" };
}

/**
 * Queue order: test priority (approved ones before the lock, without
 * priority, go by value); an opportunity's money only counts on its first
 * hypothesis. Used by list_ux_queue.
 */
export function queueOrder<
  T extends Pick<UxHypothesis, "opportunity_id" | "money" | "priority">,
>(items: T[]): T[] {
  const sorted = [...items].sort(
    (a, b) =>
      (b.priority?.teste ?? -1) - (a.priority?.teste ?? -1) ||
      (b.money?.monthly_value ?? 0) - (a.money?.monthly_value ?? 0),
  );
  const seen = new Set<string>();
  return sorted.map((h) => {
    const key = h.opportunity_id ?? "";
    if (!key || !h.money) return h;
    if (seen.has(key)) return { ...h, money: null };
    seen.add(key);
    return h;
  });
}
