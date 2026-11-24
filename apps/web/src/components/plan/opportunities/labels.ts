/** Translation keys for the engine's enums the section shows as text. */

import type { TranslationKey } from "@/i18n/use-t.ts";
import type { PageType, StoreOpportunity } from "./diagnosis-schema.ts";
import type { ConfidenceLevel, HypothesisVerdict } from "./opportunity-view.ts";

export const PAGE_LABEL: Record<PageType, TranslationKey> = {
  home: "plan.opportunities.page.home",
  categoria: "plan.opportunities.page.categoria",
  busca: "plan.opportunities.page.busca",
  pdp: "plan.opportunities.page.pdp",
  carrinho_checkout: "plan.opportunities.page.carrinho_checkout",
};

/** What moving on from each stage means, for the funnel's rate. */
export const ADVANCE_LABEL: Record<PageType, TranslationKey> = {
  home: "plan.opportunities.store.advance.home",
  categoria: "plan.opportunities.store.advance.categoria",
  busca: "plan.opportunities.store.advance.busca",
  pdp: "plan.opportunities.store.advance.pdp",
  carrinho_checkout: "plan.opportunities.store.advance.carrinho_checkout",
};

export const DEVICE_LABEL: Record<StoreOpportunity["device"], TranslationKey> =
  {
    mobile: "plan.opportunities.device.mobile",
    desktop: "plan.opportunities.device.desktop",
    ambos: "plan.opportunities.device.ambos",
  };

export const VERDICT_LABEL: Record<HypothesisVerdict, TranslationKey> = {
  confirmed: "plan.opportunities.card.verdict.confirmed",
  refuted: "plan.opportunities.card.verdict.refuted",
  inconclusive: "plan.opportunities.card.verdict.inconclusive",
  pending: "plan.opportunities.card.verdict.pending",
};

/** The engine's run stages; a stage it adds later shows as its own name. */
const STAGE_LABEL: Record<string, TranslationKey> = {
  queued: "plan.opportunities.stage.queued",
  collect: "plan.opportunities.stage.collect",
  capture: "plan.opportunities.stage.capture",
  benchmark: "plan.opportunities.stage.benchmark",
  opportunities: "plan.opportunities.stage.opportunities",
  hypotheses: "plan.opportunities.stage.hypotheses",
  verify: "plan.opportunities.stage.verify",
  relevance: "plan.opportunities.stage.relevance",
};

export function stageLabel(stage: string): TranslationKey | null {
  return Object.hasOwn(STAGE_LABEL, stage)
    ? (STAGE_LABEL[stage] ?? null)
    : null;
}

export const CONFIDENCE_LABEL: Record<ConfidenceLevel, TranslationKey> = {
  high: "plan.opportunities.detail.confidence.high",
  medium: "plan.opportunities.detail.confidence.medium",
  low: "plan.opportunities.detail.confidence.low",
};

/** Why the engine stopped investigating a loss; a reason it adds later gets
 *  the generic label. */
const STOP_LABEL: Record<string, TranslationKey> = {
  achou_causa_candidata: "plan.opportunities.detail.stop.achou_causa_candidata",
  todas_descartadas: "plan.opportunities.detail.stop.todas_descartadas",
  evidencias_esgotadas: "plan.opportunities.detail.stop.evidencias_esgotadas",
  orcamento: "plan.opportunities.detail.stop.orcamento",
  dados_insuficientes: "plan.opportunities.detail.stop.dados_insuficientes",
};

export function stopLabel(stop: string): TranslationKey {
  return (
    (Object.hasOwn(STOP_LABEL, stop) ? STOP_LABEL[stop] : undefined) ??
    "plan.opportunities.detail.stop.other"
  );
}

/** The engine's data sources; one it adds later shows as its own name. */
const SOURCE_LABEL: Record<string, TranslationKey> = {
  ga4: "plan.opportunities.detail.source.ga4",
  deco_analytics: "plan.opportunities.detail.source.deco_analytics",
  vtex: "plan.opportunities.detail.source.vtex",
  pagina: "plan.opportunities.detail.source.pagina",
  benchmark: "plan.opportunities.detail.source.benchmark",
};

export function sourceLabel(source: string): TranslationKey | null {
  return Object.hasOwn(SOURCE_LABEL, source)
    ? (SOURCE_LABEL[source] ?? null)
    : null;
}

/** What a verification check found; an outcome the engine adds later is
 *  left out rather than shown as its raw name. */
const CHECK_OUTCOME_LABEL: Record<string, TranslationKey> = {
  confirma: "plan.prompt.fromOpportunity.outcome.confirma",
  desmente: "plan.prompt.fromOpportunity.outcome.desmente",
  nao_decidiu: "plan.prompt.fromOpportunity.outcome.nao_decidiu",
  nao_testou: "plan.prompt.fromOpportunity.outcome.nao_testou",
};

export function checkOutcomeLabel(outcome: string): TranslationKey | null {
  return Object.hasOwn(CHECK_OUTCOME_LABEL, outcome)
    ? (CHECK_OUTCOME_LABEL[outcome] ?? null)
    : null;
}
