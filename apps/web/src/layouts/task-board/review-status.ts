import type { TaskBoardActivity } from "@/hooks/use-task-board-activity";
import {
  allReviewersApproved,
  type ReviewerKind,
} from "@decocms/shared/task-board";

export type { ReviewerKind };

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
 * Whether a task's PR is ready for a human to ship: every enabled reviewer
 * approved in the current review cycle, or no reviewers are enabled (nothing to
 * wait on → ready). Uses the shared cycle reducer — the SAME logic as the
 * server's auto-merge gate — but WITHOUT the token-verification requirement:
 * the human clicking "Ship to production" is the authority, so an unverified
 * approval still shows the button (only auto-merge insists on verification).
 */
export function reviewsSatisfiedForPromotion(
  activity: TaskBoardActivity[],
  enabled: ReviewerKind[],
): boolean {
  if (enabled.length === 0) return true;
  return allReviewersApproved(activity, enabled);
}
