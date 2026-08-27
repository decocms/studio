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
  movesForward,
  SHIP_ELIGIBLE_LANES,
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
      expect(LANE_RANK[lane]).toBeGreaterThan(LANE_RANK.in_review);
      expect(LANE_RANK[lane]).toBeLessThan(LANE_RANK.done);
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
