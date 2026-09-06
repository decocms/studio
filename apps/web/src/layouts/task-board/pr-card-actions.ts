import type { TaskBoardItemPr } from "./config";

/**
 * Which live actions a PR card offers, derived from the PR's GitHub state and
 * the task-level review readiness (In Review + every enabled reviewer
 * approved). Pure, so the "don't offer Ship on a conflicting PR" rule is
 * unit-tested rather than buried in the component.
 *
 * `hasConflict` is an explicit `mergeable === false` — a `null` means GitHub
 * hasn't computed mergeability yet (it's async) and must never read as a
 * conflict. A conflicting PR can't merge (the merge 405s), so it swaps the
 * optimistic Ship button for a "Resolve conflict" one under the same
 * reviewed-and-ready gate.
 */
export function prCardActions(
  pr: Pick<TaskBoardItemPr, "state" | "merged" | "mergeable" | "checksStatus">,
  reviewsReady: boolean,
): {
  isOpen: boolean;
  hasConflict: boolean;
  showShip: boolean;
  showResolveConflict: boolean;
} {
  const isOpen = pr.state === "open" && !pr.merged;
  const hasConflict = pr.mergeable === false;
  // Hide Ship only on red CI; a human may ship over in-flight (pending) checks.
  const checksOk = pr.checksStatus !== "failing";
  return {
    isOpen,
    hasConflict,
    showShip: reviewsReady && isOpen && checksOk && !hasConflict,
    showResolveConflict: reviewsReady && isOpen && hasConflict,
  };
}

/** A check the footer draws green: finished, and not a failure. Shared with
 *  `checkRunStyle` so the collapsed score can never disagree with the icons
 *  the expanded list shows. */
export function isSuccessfulCheck(
  check: TaskBoardItemPr["checks"][number],
): boolean {
  if (check.status !== "completed") return false;
  const c = check.conclusion;
  return c === "success" || c === "neutral" || c === "skipped";
}

/**
 * The score a COLLAPSED checks footer shows in place of "Checks failing".
 *
 * A red "Checks failing" reads as "the whole build is broken" even when one of
 * seven checks failed — which is the common case, and the one people act on. So
 * the closed header reports how many passed, in warning. `null` means keep the
 * normal header: the checks aren't failing, the footer is open (the user is
 * looking AT the failures, and red is how they find them), or there are no
 * check rows to count.
 */
export function collapsedChecksScore(
  checksStatus: TaskBoardItemPr["checksStatus"],
  checks: TaskBoardItemPr["checks"],
  checksOpen: boolean,
): { passed: number; total: number } | null {
  if (checksStatus !== "failing" || checksOpen || checks.length === 0) {
    return null;
  }
  return {
    passed: checks.filter(isSuccessfulCheck).length,
    total: checks.length,
  };
}
