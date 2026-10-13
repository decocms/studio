/**
 * Board lane order, and the questions that depend on it.
 *
 * `LANE_RANK` is a total order over the lanes, used as a forward-only guard:
 * automation moves a card ALONG the board, never back. It is an exhaustive
 * `Record` over `TaskBoardItemStatus` on purpose — adding a lane is then a
 * compile error here rather than a silent rank collision.
 *
 * Lives in its own module (rather than in `run-reactions`, where the table used
 * to be) because the guard is read from `prs-get` and `promote-to-production`
 * too, and those importing `run-reactions` for a constant would be a cycle.
 */

import {
  CANONICAL_COLUMN_KEYS,
  type CanonicalColumnKey,
  isDormantLane,
  LANES,
} from "@decocms/shared/task-board";
import type { TaskBoardItemStatus } from "@/storage/types";

const RANK_BY_KEY = Object.fromEntries(
  CANONICAL_COLUMN_KEYS.map((key, index) => [key, index]),
) as Record<CanonicalColumnKey, number>;

/** Annotated, not cast: a status added to the union with no place in
 *  `CANONICAL_COLUMN_KEYS` fails to satisfy this `Record` and is a compile
 *  error here, which is the whole reason the table is exhaustive. */
export const LANE_RANK: Record<TaskBoardItemStatus, number> = RANK_BY_KEY;

/** Widened read of the same table: a card's status is typed as any column
 *  key, and the closed Record would not accept it as an index. */
const RANK_LOOKUP: Record<string, number> = LANE_RANK;

/** Where a status sits in board order. Every status is a canonical column, so
 *  an unknown key is a corrupt row, not a case to reason about. */
export function laneRank(status: string): number {
  const rank = RANK_LOOKUP[status];
  if (rank === undefined) throw new Error(`Unknown board column "${status}"`);
  return rank;
}

/** The statuses a card or a column rule may be given: every lane but the
 *  dormant ones. */
export const OFFERED_COLUMN_KEYS: CanonicalColumnKey[] =
  CANONICAL_COLUMN_KEYS.filter((key) => !isDormantLane(key));

/**
 * Refuses a write that would put a card in a lane this release does not offer
 * (`DORMANT_LANES`). The schema accepts those statuses so a card the previous
 * release left in one still reads; nothing here may move a card into one.
 */
export function refuseDormantLane(status: string | undefined): void {
  if (status === undefined || !isDormantLane(status)) return;
  throw new Error(
    `The "${status}" column is not on this board; use a column the board ` +
      "shows.",
  );
}

/**
 * True when moving `from` → `to` advances the card.
 *
 * Every automatic move must go through this rather than enumerating the lanes
 * it refuses to leave (`status !== "done" && status !== "archived"`): an
 * enumeration is correct only for the lanes that existed when it was written,
 * so adding one silently turns it into a path that drags cards BACKWARD.
 */
export function movesForward(from: string, to: string): boolean {
  return laneRank(to) > laneRank(from);
}

/**
 * True when a card in `from` may still be advanced to `to`: it sits at or
 * before it. What stops a re-opened PR dragging a finished card backwards,
 * while letting a repeated trigger on the target lane stay a no-op.
 */
export function atOrBefore(from: string, to: string): boolean {
  return laneRank(from) <= laneRank(to);
}

/**
 * True where a merged pull request can have left the card, which is what the
 * merged-tag sweep gates on. Mirrors `TAGGABLE_MERGED_STATUSES` in storage: the
 * candidate query and the re-read inside the org's context have to agree, or
 * the sweep picks cards it then refuses. `merged` is the previous board's.
 */
export function isTaggableMergedStatus(status: string): boolean {
  return (
    status === LANES.shipped || status === LANES.done || status === "merged"
  );
}

/**
 * True while a card is in its REVIEW PHASE: the agent reviewer owns it, or it
 * was handed to a person in In Review.
 *
 * Not `status === "in_review"` alone: an In Progress card with an open cycle
 * is one whose cycle opened before the previous release moved reviews into
 * In Review, and its verdict is still to come.
 *
 * Still bounded by rank: a card past In Review (QA and beyond) is out of the
 * phase whatever a stale cycle stamp says, so a missed `closeReviewCycle` can
 * never drag it back into the sweeper's work.
 */
export function inReviewPhase(item: {
  status: string;
  reviewCycleStartedAt: string | null;
}): boolean {
  if (laneRank(item.status) > LANE_RANK.in_review) return false;
  // Truthiness, not `!== null`: an absent stamp must read as "no cycle", and
  // a partial item (a fixture, a projection) carries `undefined`, not `null`.
  return item.status === LANES.review || Boolean(item.reviewCycleStartedAt);
}
