/** Translation keys for the engine's enums the section shows as text. */

import type { TranslationKey } from "@/i18n/use-t.ts";
import type { PageType, StoreOpportunity } from "./diagnosis-schema.ts";
import type { HypothesisVerdict } from "./opportunity-view.ts";

export const PAGE_LABEL: Record<PageType, TranslationKey> = {
  home: "plan.opportunities.page.home",
  categoria: "plan.opportunities.page.categoria",
  busca: "plan.opportunities.page.busca",
  pdp: "plan.opportunities.page.pdp",
  carrinho_checkout: "plan.opportunities.page.carrinho_checkout",
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
