import type { TaskBoardActivity } from "@/hooks/use-task-board-activity";
import type { TaskBoardItem } from "./config";
import {
  allReviewersApproved,
  REVIEWER_KINDS,
  type ReviewerKind,
} from "@decocms/shared/task-board";

export type { ReviewerKind };

/** One reviewer's standing verdict, as the board list ships it. */
type TaskBoardItemReviewVerdict = TaskBoardItem["reviewVerdicts"][number];

/** The enabled reviewers, as a list — one reviewer, so the list is empty or
 *  `REVIEWER_KINDS`. A list because every consumer below reads a SET of
 *  reviewers, which is what makes adding a second one back a one-line change. */
export function enabledReviewers(enabled: boolean): ReviewerKind[] {
  return enabled ? REVIEWER_KINDS : [];
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
  /** The card's `reviewCycleStartedAt` — the boundary the approvals have to sit
   *  inside. Since migration 189 it is a column, not a lane transition, so the
   *  activity timeline alone can no longer date the cycle. */
  cycleStartedAt: string | null,
): boolean {
  if (enabled.length === 0) return true;
  return allReviewersApproved(activity, enabled, { cycleStartedAt });
}

/** What a card's checks indicator shows: how many enabled reviewers have
 *  signed off, and how that reads at a glance. */
export type ChecksSummary = {
  passed: number;
  total: number;
  tone: "danger" | "pending" | "ok";
};

/**
 * The card's `0/1` checks indicator, or null when this org runs no reviewers
 * (nothing to count, so nothing to show).
 *
 * `verdicts` arrive already scoped to the current cycle by the server (see
 * `attachRefs`), so this reducer needs no cycle argument of its own.
 *
 * The chip must never contradict its own number: if it says `1/1`, it is green.
 * An earlier cut held a full set of approvals at amber when they weren't
 * token-verified (`approvedButUnverified` — approvals that can't satisfy the
 * auto-merge gate), which read as "100%, but no". Verification is a different
 * question from how many reviewers approved, so it lives in the tooltip and
 * never in the colour.
 *
 * The one place `tone` is not `passed/total`: a reviewer that asked for CHANGES
 * is not a reviewer that hasn't run yet, so `0/1` with an outstanding
 * change-request reads `danger` — someone has to act on it — while `0/1` still
 * waiting on the reviewer is merely `pending`.
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

/**
 * Lanes the "Ship to production" button may act from. Must mirror the server's
 * `SHIP_ELIGIBLE_LANES`: offering more puts a control on screen that always
 * errors, offering fewer makes Approved a dead end.
 */
export function laneCanShip(status: string): boolean {
  return status === "in_review" || status === "approved";
}
