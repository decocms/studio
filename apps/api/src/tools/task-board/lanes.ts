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

import { DELIVERY_LANES } from "@decocms/shared/task-board";
import type { TaskBoardItemStatus } from "@/storage/types";

export const LANE_RANK: Record<TaskBoardItemStatus, number> = {
  triage: 0,
  todo: 1,
  in_progress: 2,
  in_review: 3,
  approved: 4,
  merged: 5,
  post_deploy_validation: 6,
  done: 7,
  archived: 8,
};

/** The delivery lanes, as board statuses — the assertion that the shared
 *  literal union stays a subset of this side's lane vocabulary. */
export const DELIVERY_LANE_STATUSES: TaskBoardItemStatus[] = DELIVERY_LANES;

/** True for one of the post-merge delivery lanes (Approved, Merged, Post-deploy
 *  Validation) — the statuses that only exist for an org running
 *  `delivery_lanes_enabled`. Mirrors the web-side `isDeliveryLane` in
 *  `layouts/task-board/config.tsx`. */
export function isDeliveryLane(status: TaskBoardItemStatus): boolean {
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
export function movesForward(
  from: TaskBoardItemStatus,
  to: TaskBoardItemStatus,
): boolean {
  return LANE_RANK[to] > LANE_RANK[from];
}

/**
 * Lanes the "Ship to production" button may act from: In Review (auto-merge
 * off, reviewers approved) and Approved (a human parked it there deliberately).
 * Without Approved, moving a card into it would lock the ship button out — the
 * lane would be a dead end.
 */
export const SHIP_ELIGIBLE_LANES: ReadonlySet<TaskBoardItemStatus> = new Set([
  "in_review",
  "approved",
]);

/**
 * True where a merged pull request can have left the card, which is what the
 * merged-tag sweep gates on. Mirrors `TAGGABLE_MERGED_STATUSES` in storage: the
 * candidate query and the re-read inside the org's context have to agree, or
 * the sweep picks cards it then refuses.
 */
export function isTaggableMergedStatus(status: TaskBoardItemStatus): boolean {
  return status === "done" || DELIVERY_LANE_STATUSES.includes(status);
}
