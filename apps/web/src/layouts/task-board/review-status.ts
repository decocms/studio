import type { TaskBoardActivity } from "@/hooks/use-task-board-activity";

export type ReviewerKind = "qa" | "code_review";

/** The enabled reviewers, as a list, from the two org flags. */
export function enabledReviewers(flags: {
  qa: boolean;
  codeReview: boolean;
}): ReviewerKind[] {
  const out: ReviewerKind[] = [];
  if (flags.qa) out.push("qa");
  if (flags.codeReview) out.push("code_review");
  return out;
}

/**
 * Whether a task's PR is ready for a human to ship: every enabled reviewer has
 * `approve` as its latest decision in the current review cycle (since the task
 * last entered In Review). With no reviewers enabled there's nothing to wait on,
 * so it's ready. Mirrors the server's `allEnabledReviewersApproved`, but returns
 * `true` (not `false`) for the no-reviewers case — the button is a human's
 * escape hatch, not the auto-merge gate. Pure, so it's unit-tested.
 */
export function reviewsSatisfiedForPromotion(
  activity: TaskBoardActivity[],
  enabled: ReviewerKind[],
): boolean {
  if (enabled.length === 0) return true;

  let lastInReviewAt = 0;
  for (const a of activity) {
    if (
      a.action === "status_changed" &&
      (a.data as { to?: unknown })?.to === "in_review"
    ) {
      lastInReviewAt = Math.max(
        lastInReviewAt,
        new Date(a.occurredAt).getTime(),
      );
    }
  }

  const latest = new Map<ReviewerKind, "approved" | "changes_requested">();
  for (const a of activity) {
    if (
      a.action !== "review_approved" &&
      a.action !== "review_changes_requested"
    ) {
      continue;
    }
    if (new Date(a.occurredAt).getTime() < lastInReviewAt) continue;
    const reviewer = (a.data as { reviewer?: unknown })?.reviewer;
    if (reviewer !== "qa" && reviewer !== "code_review") continue;
    latest.set(
      reviewer,
      a.action === "review_approved" ? "approved" : "changes_requested",
    );
  }

  return enabled.every((k) => latest.get(k) === "approved");
}
