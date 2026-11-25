/**
 * Quais hipóteses merecem atenção — duas decisões diferentes:
 *
 * - prioridade de INVESTIGAÇÃO: vale a pena olhar isto agora? Sobe com o
 *   impacto e a abrangência, e com a INCERTEZA (o que já está provado não
 *   precisa de mais investigação).
 * - prioridade de TESTE: vale um A/B? Sobe com impacto, confiança,
 *   abrangência e mensurabilidade; cai com esforço e risco. Só pra pronta.
 *
 * A confiança não é a do modelo: é a qualidade da evidência. Um fato medido
 * aqui pesa mais que um benchmark; um A/B desta loja pesa mais que um estudo;
 * cada nível de validação confirmado soma. Teto de 0,9: causa nunca está
 * provada antes do A/B.
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
  /** 0–1. Quanto vale investigar agora. */
  investigacao: number;
  /** 0–1, só pra pronta pro teste. NULL = ainda não dá pra testar. */
  teste: number | null;
  /** Como cada fator saiu, em palavras. */
  notas: string[];
}

/** 1 − Π(1 − wᵢ): somar evidências independentes sem passar de 1. */
const combine = (weights: number[]) =>
  1 - weights.reduce((acc, w) => acc * (1 - w), 1);

const round2 = (v: number) => Math.round(v * 100) / 100;

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
  /** A meta da rodada: entra nas notas como contexto, nunca na conta. */
  objective?: string | null;
}): HypothesisPriority {
  const { hypothesis: h, opportunity: o } = input;
  const notas: string[] = [];
  const goal = input.objective?.trim();
  if (goal) notas.push(`meta da rodada: ${goal}`);
  const tree = h.tree ?? null;

  // Impacto: o valor da OPORTUNIDADE (contado uma vez), em escala log.
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

  // Confiança pela qualidade da evidência.
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

  // Abrangência: quem a mudança atinge × a fatia do dispositivo.
  const devices = input.evidence.pdp_behaviour;
  const total = devices.reduce((a, b) => a + b.views, 0);
  const mine = devices.find(
    (b) => b.device === (h.device === "desktop" ? "desktop" : "mobile"),
  );
  const deviceShare = total > 0 && mine ? mine.views / total : 1;
  const affected = (input.relevance?.affected_pct ?? 100) / 100;
  const abrangencia = Math.min(1, affected * deviceShare);

  const esforco = EFFORT_FACTOR[tree?.esforco ?? 2];
  // Risco: mexer no botão de compra ou no checkout pode derrubar a venda; um
  // A/B desta loja que perdeu na mesma parte também.
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

/**
 * Pronta pro teste: relevância pelo menos média, teste mensurável com o
 * tráfego de hoje, e os dados da oportunidade sem nada que bloqueie.
 */
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
 * A ordem da fila: prioridade de teste (as aprovadas antes da trava, sem
 * prioridade, vão por valor), e o dinheiro de uma oportunidade só na primeira
 * hipótese dela — duas aprovadas da mesma oportunidade mostravam o valor
 * inteiro cada uma. Usado por list_ux_queue.
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
