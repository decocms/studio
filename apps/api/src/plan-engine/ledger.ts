/**
 * Causes earlier rounds refuted on this page type, keyed so triage can drop a
 * repeat in code instead of trusting the prompt. A verdict holds for the page
 * as it was: once the page changes (`markStale`), the cause may be tried
 * again, and refuting it again records a verdict on the new page.
 */

import type { KnowledgeEntry } from "./knowledge/types.ts";
import { crossRunKey } from "./triage.ts";
import type { UxHypothesis, UxPageType } from "./types.ts";

export interface PriorRefutation {
  title: string;
  /** Why it fell, from the verifier. */
  why: string;
  diagnosisId: string;
}

/** The refuted verdicts that still hold, from another round of this page type. */
export function heldRefutations(
  entries: KnowledgeEntry[],
  pageType: UxPageType,
  currentDiagnosisId: string,
): KnowledgeEntry[] {
  return entries.filter(
    (e) =>
      e.active &&
      e.origem === "veredito" &&
      e.resultado === "refutada" &&
      !e.stale &&
      e.hypothesis_id !== null &&
      e.diagnosis_id !== currentDiagnosisId &&
      e.assinatura?.startsWith(`${pageType}|`) === true,
  );
}

/** `crossRunKey` → the refutation, for the hypotheses behind `held`. */
export function priorRefutations(
  held: KnowledgeEntry[],
  hypotheses: Array<Pick<UxHypothesis, "id" | "title" | "tree">>,
): Map<string, PriorRefutation> {
  const byId = new Map(hypotheses.map((h) => [h.id, h]));
  const out = new Map<string, PriorRefutation>();
  for (const e of held) {
    const h = byId.get(e.hypothesis_id ?? "");
    const key = h?.tree ? crossRunKey(h.tree) : null;
    if (!h || !key || out.has(key)) continue;
    out.set(key, {
      title: h.title,
      why: e.evidencia,
      diagnosisId: e.diagnosis_id ?? "",
    });
  }
  return out;
}
