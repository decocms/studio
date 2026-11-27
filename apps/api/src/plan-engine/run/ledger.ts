/**
 * Reads the causes earlier rounds refuted on this page for a hypotheses call
 * (ledger.ts). A failed read degrades to none: the knowledge block still
 * carries those verdicts to the model.
 */

import { markStale } from "../knowledge/validity.ts";
import type { KnowledgeEntry } from "../knowledge/types.ts";
import {
  heldRefutations,
  type PriorRefutation,
  priorRefutations,
} from "../ledger.ts";
import type { DiagnosisEvidence } from "../types.ts";
import type { EngineRun } from "./engine-run.ts";

/** Newest verdicts read per call, so the prompt block and the query stay bounded. */
const MAX_PRIOR = 40;

export async function refutedBeforeFor(
  run: EngineRun,
  evidence: DiagnosisEvidence,
  entries: KnowledgeEntry[],
): Promise<Map<string, PriorRefutation>> {
  const held = heldRefutations(
    markStale(entries, evidence),
    evidence.page_type ?? "pdp",
    run.id,
  )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, MAX_PRIOR);
  if (held.length === 0) return new Map();
  try {
    const hypotheses = await run.store.listHypothesesByIds(
      run.orgId,
      held.map((e) => e.hypothesis_id ?? ""),
    );
    return priorRefutations(held, hypotheses);
  } catch (err) {
    console.warn(
      "[plan-engine] earlier refutations unavailable:",
      err instanceof Error ? err.message : String(err),
    );
    return new Map();
  }
}
