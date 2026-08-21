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
