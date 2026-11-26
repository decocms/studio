/**
 * What a run spends, as drafts for the spend ledger (`plan_cost_events`). A
 * step collects them and writes them once, under a scope that makes the ids
 * deterministic, so a replayed step does not count the same call twice.
 */

import type { CostEventDraft } from "../storage/plan-engine-costs.ts";
import { type BigQueryScan, scanCostUsd } from "./bigquery.ts";
import type { LlmUsage } from "./ports.ts";

const FEATURE = "ux_diagnosis";

/**
 * USD per million tokens at the provider's list price, for providers that do
 * not report a call's cost. A model missing here is recorded unpriced, never
 * as free.
 */
const PRICE_TABLE: Readonly<
  Record<string, { inputPerMTok: number; outputPerMTok: number }>
> = {
  "anthropic/claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "anthropic/claude-opus-5.5": { inputPerMTok: 4, outputPerMTok: 20 },
  "anthropic/claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "anthropic/claude-sonnet-5.5": { inputPerMTok: 2, outputPerMTok: 10 },
  "anthropic/claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/** Six decimals keep sub-cent calls visible. */
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export function llmCostUsd(usage: LlmUsage): number | null {
  if (usage.costUsd !== undefined) return round(usage.costUsd);
  const price = PRICE_TABLE[usage.model];
  if (!price) return null;
  return round(
    (usage.promptTokens * price.inputPerMTok) / 1_000_000 +
      (usage.completionTokens * price.outputPerMTok) / 1_000_000,
  );
}

export interface CostCollector {
  drafts: CostEventDraft[];
  llm: (usage: LlmUsage) => void;
  scan: (scan: BigQueryScan) => void;
}

/** Drafts keyed `c0`, `c1`…, in the order the calls finished. */
export function createCostCollector(jobId: string): CostCollector {
  const drafts: CostEventDraft[] = [];
  const key = () => `c${drafts.length}`;
  return {
    drafts,
    llm: (usage) => {
      drafts.push({
        key: key(),
        provider: usage.provider,
        kind: "chat",
        feature: FEATURE,
        model: usage.model,
        unitsIn: usage.promptTokens,
        unitsOut: usage.completionTokens,
        costUsd: llmCostUsd(usage),
        jobId,
      });
    },
    scan: (scan) => {
      drafts.push({
        key: key(),
        provider: "bigquery",
        kind: "query",
        feature: FEATURE,
        model: scan.label,
        unitsIn: scan.bytesBilled,
        unitsOut: null,
        costUsd: scan.cacheHit ? 0 : scanCostUsd(scan.bytesBilled),
        jobId,
      });
    },
  };
}

export function costTotal(c: CostCollector): number {
  return c.drafts.reduce((sum, d) => sum + (d.costUsd ?? 0), 0);
}
