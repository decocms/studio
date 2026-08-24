import type { TaskBoardActivity } from "@/hooks/use-task-board-activity";
import type { TaskBoardItem } from "./config";
import {
  allReviewersApproved,
  type ReviewerKind,
} from "@decocms/shared/task-board";

export type { ReviewerKind };

/** One reviewer's standing verdict, as the board list ships it. */
type TaskBoardItemReviewVerdict = TaskBoardItem["reviewVerdicts"][number];

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

/** What a card's checks indicator shows: how many enabled reviewers have
 *  signed off, and how that reads at a glance. */
export type ChecksSummary = {
  passed: number;
  total: number;
  tone: "danger" | "pending" | "ok";
};

/**
 * The card's `1/2` checks indicator, or null when this org runs no reviewers
 * (nothing to count, so nothing to show).
 *
 * `tone` is deliberately not a function of `passed/total` alone:
 *
 * - A reviewer that asked for CHANGES is not a reviewer that hasn't run yet.
 *   `1/2` with an outstanding change-request is a card someone must act on, so
 *   it reads `danger` even though half the checks are green.
 * - A full set of approvals that are not token-verified can never auto-merge —
 *   `approvedButUnverified` calls it "a dead end that looks like progress" — so
 *   it stays `pending` rather than going green and claiming to be done.
 *
 * A verdict from a reviewer the org has since disabled is ignored: `enabled` is
 * the only thing that sets the denominator, and a stale reviewer's opinion must
 * not be able to hold a card back or push it green.
 */
export function checksSummary(
  verdicts: TaskBoardItemReviewVerdict[],
  enabled: ReviewerKind[],
): ChecksSummary | null {
  if (enabled.length === 0) return null;

  const relevant = enabled.map((kind) =>
    verdicts.find((v) => v.reviewer === kind),
  );
  const approvals = relevant.filter((v) => v?.verdict === "approved");
  const summary = {
    passed: approvals.length,
    total: enabled.length,
  };

  if (relevant.some((v) => v?.verdict === "changes_requested")) {
    return { ...summary, tone: "danger" };
  }
  if (approvals.length === 0) return { ...summary, tone: "danger" };
  if (approvals.length < enabled.length) return { ...summary, tone: "pending" };
  return {
    ...summary,
    tone: approvals.every((v) => v?.verified) ? "ok" : "pending",
  };
}
