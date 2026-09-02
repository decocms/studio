/**
 * The lane order and the two questions that ride on it.
 *
 * These are the assertions that make "flag off means nothing changed" and
 * "automation never drags a card backward" checkable facts rather than a
 * property five call sites happen to agree on.
 */

import { describe, expect, it } from "bun:test";
import { DELIVERY_LANES, shippedLane } from "@decocms/shared/task-board";
import type { TaskBoardItemStatus } from "@/storage/types";
import {
  DELIVERY_LANE_STATUSES,
  LANE_RANK,
  SHIP_ELIGIBLE_LANES,
  inReviewPhase,
  laneRank,
  movesForward,
} from "./lanes";

const BOARD_ORDER: TaskBoardItemStatus[] = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "approved",
  "merged",
  "post_deploy_validation",
  "done",
  "archived",
];

describe("LANE_RANK", () => {
  it("is strictly increasing in board order", () => {
    const ranks = BOARD_ORDER.map((s) => LANE_RANK[s]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("puts every delivery lane between In Review and Done", () => {
    for (const lane of DELIVERY_LANE_STATUSES) {
      expect(laneRank(lane)).toBeGreaterThan(LANE_RANK.in_review);
      expect(laneRank(lane)).toBeLessThan(LANE_RANK.done);
    }
  });

  it("covers every lane the board knows", () => {
    expect(Object.keys(LANE_RANK).sort()).toEqual([...BOARD_ORDER].sort());
  });

  // The shared union must stay assignable to this side's lane type.
  it("agrees with the shared delivery-lane names", () => {
    expect(DELIVERY_LANE_STATUSES).toEqual(DELIVERY_LANES);
  });
});

describe("movesForward", () => {
  it("advances along the board", () => {
    expect(movesForward("in_review", "merged")).toBe(true);
    expect(movesForward("in_review", "done")).toBe(true);
    expect(movesForward("merged", "post_deploy_validation")).toBe(true);
  });

  // `prs-get`'s old enumerated guard dragged a card resting past Merged back.
  it("refuses to drag a card back to an earlier lane", () => {
    expect(movesForward("post_deploy_validation", "merged")).toBe(false);
    expect(movesForward("done", "merged")).toBe(false);
    expect(movesForward("archived", "merged")).toBe(false);
    expect(movesForward("in_review", "in_progress")).toBe(false);
  });

  it("is not satisfied by staying put", () => {
    for (const lane of BOARD_ORDER) {
      expect(movesForward(lane, lane)).toBe(false);
    }
  });
});

describe("shippedLane", () => {
  // Every falsy shape of the flags bag must resolve to `done` — that IS the guarantee.
  it("ships to Done by default", () => {
    expect(shippedLane(undefined)).toBe("done");
    expect(shippedLane(null)).toBe("done");
    expect(shippedLane({})).toBe("done");
    expect(shippedLane({ delivery_lanes_enabled: false })).toBe("done");
    expect(shippedLane({ auto_merge: true })).toBe("done");
  });

  it("ships to Merged once the org runs the delivery lanes", () => {
    expect(shippedLane({ delivery_lanes_enabled: true })).toBe("merged");
  });

  it("always names a lane a merged PR may actually move to", () => {
    for (const flags of [{}, { delivery_lanes_enabled: true }]) {
      expect(movesForward("in_review", shippedLane(flags))).toBe(true);
    }
  });
});

describe("SHIP_ELIGIBLE_LANES", () => {
  it("is exactly In Review and Approved", () => {
    expect([...SHIP_ELIGIBLE_LANES].sort()).toEqual(["approved", "in_review"]);
  });

  // Reachable from every reviewed-but-unshipped lane, and from none that shipped.
  it("excludes the lanes a shipped card rests in", () => {
    for (const lane of ["merged", "post_deploy_validation", "done"] as const) {
      expect(SHIP_ELIGIBLE_LANES.has(lane)).toBe(false);
    }
  });
});

describe("inReviewPhase", () => {
  const card = (
    status: TaskBoardItemStatus,
    reviewCycleStartedAt: string | null = null,
  ) => ({ status, reviewCycleStartedAt });
  const CYCLE = "2026-01-01T10:00:00.000Z";

  // The whole point of migration 190: a card whose reviewer is working reads
  // In Progress, and only the open cycle says it is under review.
  it("covers an In Progress card with an open cycle", () => {
    expect(inReviewPhase(card("in_progress", CYCLE), "in_review")).toBe(true);
    expect(inReviewPhase(card("in_progress"), "in_review")).toBe(false);
  });

  it("covers In Review with or without a cycle stamp", () => {
    expect(inReviewPhase(card("in_review", CYCLE), "in_review")).toBe(true);
    // Pre-migration cards carry no stamp; the lane still answers for them.
    expect(inReviewPhase(card("in_review"), "in_review")).toBe(true);
  });

  // A stale stamp must never drag a shipped card back into the sweeper's work.
  it("is false past In Review however stale the stamp", () => {
    for (const lane of [
      "approved",
      "merged",
      "post_deploy_validation",
      "done",
      "archived",
    ] as const) {
      expect(inReviewPhase(card(lane, CYCLE), "in_review")).toBe(false);
    }
  });

  it("is false for a card that has not been worked yet", () => {
    expect(inReviewPhase(card("triage"), "in_review")).toBe(false);
    expect(inReviewPhase(card("todo"), "in_review")).toBe(false);
  });

  /**
   * The bug this argument exists for. On a board mirrored from a tracker the
   * review column is called whatever that tracker calls it, so comparing
   * against Studio's name read every parked card as out of the phase — and the
   * sweeper, the merge retry and the own-review guard all skipped it in
   * silence.
   */
  it("answers for a review column the tracker named", () => {
    const parked = { status: "Code Review", reviewCycleStartedAt: null };
    expect(inReviewPhase(parked, "Code Review")).toBe(true);
    expect(inReviewPhase(parked, "in_review")).toBe(false);
  });

  /** A board with no review column still has cards under review — the open
   *  cycle is the durable fact, and it does not need a lane to be true. */
  it("still covers an open cycle when the board has no review column", () => {
    expect(
      inReviewPhase({ status: "Fazendo", reviewCycleStartedAt: CYCLE }, null),
    ).toBe(true);
    expect(
      inReviewPhase({ status: "Fazendo", reviewCycleStartedAt: null }, null),
    ).toBe(false);
  });
});
