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
  DELIVERY_LANES,
} from "@decocms/shared/task-board";
import type { TaskBoardItemStatus } from "@/storage/types";

const RANK_BY_KEY = Object.fromEntries(
  CANONICAL_COLUMN_KEYS.map((key, index) => [key, index]),
) as Record<CanonicalColumnKey, number>;

/** Annotated, not cast: a status added to the union with no place in
 *  `CANONICAL_COLUMN_KEYS` fails to satisfy this `Record` and is a compile
 *  error here, which is the whole reason the table is exhaustive. */
export const LANE_RANK: Record<TaskBoardItemStatus, number> = RANK_BY_KEY;

/** Widened read of the same table. A card's status is any column key, and
 *  indexing the closed Record would let the compiler believe every status has
 *  a rank. */
const RANK_LOOKUP: Record<string, number> = LANE_RANK;

/**
 * Where a status sits in Studio's own order, or null for a column Studio did
 * not define.
 *
 * An org board's order is its columns' positions, not this table, so null is
 * the honest answer rather than a guessed rank — and callers decide what an
 * unrankable status means for them, instead of silently comparing against a
 * number that was invented.
 */
export function laneRank(status: string): number | null {
  return RANK_LOOKUP[status] ?? null;
}

/** The delivery lanes, as board statuses — the assertion that the shared
 *  literal union stays a subset of this side's lane vocabulary. */
export const DELIVERY_LANE_STATUSES: string[] = DELIVERY_LANES;

/** True for one of the post-merge delivery lanes (Approved, Merged, Post-deploy
 *  Validation) — the statuses that only exist for an org running
 *  `delivery_lanes_enabled`. Mirrors the web-side `isDeliveryLane` in
 *  `layouts/task-board/config.tsx`. */
export function isDeliveryLane(status: string): boolean {
  return DELIVERY_LANE_STATUSES.includes(status);
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
  const before = laneRank(from);
  const after = laneRank(to);
  // Either side unrankable means one of them is a column Studio did not
  // define. There is no order to be forward in, so the guard abstains rather
  // than inventing one.
  if (before === null || after === null) return true;
  return after > before;
}

/**
 * Lanes the "Ship to production" button may act from: In Review (auto-merge
 * off, reviewers approved) and Approved (a human parked it there deliberately).
 * Without Approved, moving a card into it would lock the ship button out — the
 * lane would be a dead end.
 */
export const SHIP_ELIGIBLE_LANES: ReadonlySet<string> = new Set([
  "in_review",
  "approved",
]);

/**
 * True where a merged pull request can have left the card, which is what the
 * merged-tag sweep gates on. Mirrors `TAGGABLE_MERGED_STATUSES` in storage: the
 * candidate query and the re-read inside the org's context have to agree, or
 * the sweep picks cards it then refuses.
 */
export function isTaggableMergedStatus(status: string): boolean {
  return status === "done" || DELIVERY_LANE_STATUSES.includes(status);
}

/**
 * True while a card is in its REVIEW PHASE: a reviewer owns it, or it is parked
 * In Review waiting on a person.
 *
 * This is the gate every automatic review path takes, and it is deliberately
 * not `status === "in_review"`. Since migration 190 an agent reviewer runs
 * while the card still reads In Progress — the lane says whose turn it is, and
 * during a review it is nobody's — so the durable fact is the open cycle
 * (`reviewCycleStartedAt`), not the lane.
 *
 * Still bounded by rank: a card that has shipped (Approved and beyond) is out
 * of the phase whatever a stale cycle stamp says, so a missed `closeReviewCycle`
 * can never drag a merged card back into the sweeper's work.
 */
export function inReviewPhase(
  item: {
    status: string;
    reviewCycleStartedAt: string | null;
  },
  /** The column this board parks a card in for review, or null when it has
   *  none. Passed rather than assumed: on a board mirrored from a tracker the
   *  lane is called whatever that tracker calls it, and comparing against
   *  Studio's name reads every such card as out of the phase. */
  reviewLane: string | null,
): boolean {
  const rank = laneRank(item.status);
  // A column Studio did not define has no place in this order, so the rank
  // bound simply does not apply to it.
  if (rank !== null && rank > LANE_RANK.in_review) return false;
  // Truthiness, not `!== null`: an absent stamp must read as "no cycle", and
  // a partial item (a fixture, a projection) carries `undefined`, not `null`.
  return (
    (reviewLane !== null && item.status === reviewLane) ||
    Boolean(item.reviewCycleStartedAt)
  );
}
