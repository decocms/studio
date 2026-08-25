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
 * The chip must never contradict its own number: if it says `2/2`, it is green.
 * An earlier cut held a full set of approvals at amber when they weren't
 * token-verified (`approvedButUnverified` — approvals that can't satisfy the
 * auto-merge gate), which read as "100%, but no". Verification is a different
 * question from how many reviewers approved, so it lives in the tooltip and
 * never in the colour.
 *
 * The one place `tone` is not `passed/total`: a reviewer that asked for CHANGES
 * is not a reviewer that hasn't run yet, so `1/2` with an outstanding
 * change-request reads `danger` — someone has to act on it — while `1/2` still
 * waiting on its second reviewer is merely `pending`.
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
  return { ...summary, tone: "ok" };
}
