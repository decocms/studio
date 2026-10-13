/**
 * The lane order and the questions that ride on it.
 *
 * These are the assertions that make "automation never drags a card backward"
 * and "an agent never passes a person's check" checkable facts rather than a
 * property several call sites happen to agree on.
 */

import { describe, expect, it } from "bun:test";
import type { TaskBoardItemStatus } from "@/storage/types";
import {
  agentMoveRefusal,
  inReviewPhase,
  isTaggableMergedStatus,
  LANE_RANK,
  laneRank,
  movesForward,
  OFFERED_COLUMN_KEYS,
  refuseDormantLane,
} from "./lanes";

const BOARD_ORDER: TaskBoardItemStatus[] = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "qa",
  "customer_approval",
  "approved",
  "ready_for_deployment",
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

  it("puts the people's checks and the release between In Review and Done", () => {
    for (const lane of [
      "qa",
      "customer_approval",
      "ready_for_deployment",
      "post_deploy_validation",
    ]) {
      expect(laneRank(lane)).toBeGreaterThan(LANE_RANK.in_review);
      expect(laneRank(lane)).toBeLessThan(LANE_RANK.done);
    }
  });

  it("covers every lane the board knows", () => {
    expect(Object.keys(LANE_RANK).sort()).toEqual([...BOARD_ORDER].sort());
  });
});

describe("movesForward", () => {
  it("advances along the board", () => {
    expect(movesForward("in_review", "qa")).toBe(true);
    expect(movesForward("in_review", "done")).toBe(true);
    expect(movesForward("ready_for_deployment", "post_deploy_validation")).toBe(
      true,
    );
  });

  // `prs-get`'s old enumerated guard dragged a card resting past a merge back.
  it("refuses to drag a card back to an earlier lane", () => {
    expect(movesForward("done", "post_deploy_validation")).toBe(false);
    expect(movesForward("archived", "post_deploy_validation")).toBe(false);
    expect(movesForward("qa", "in_review")).toBe(false);
    expect(movesForward("in_review", "in_progress")).toBe(false);
  });

  it("is not satisfied by staying put", () => {
    for (const lane of BOARD_ORDER) {
      expect(movesForward(lane, lane)).toBe(false);
    }
  });
});

describe("isTaggableMergedStatus", () => {
  it("covers the lanes a merged PR leaves a card in, the previous board's included", () => {
    for (const lane of ["post_deploy_validation", "done", "merged"]) {
      expect(isTaggableMergedStatus(lane)).toBe(true);
    }
    for (const lane of ["ready_for_deployment", "qa", "archived"]) {
      expect(isTaggableMergedStatus(lane)).toBe(false);
    }
  });
});

describe("inReviewPhase", () => {
  const card = (
    status: TaskBoardItemStatus,
    reviewCycleStartedAt: string | null = null,
  ) => ({ status, reviewCycleStartedAt });
  const CYCLE = "2026-01-01T10:00:00.000Z";

  // A cycle the previous release opened while the card read In Progress.
  it("covers an In Progress card with an open cycle", () => {
    expect(inReviewPhase(card("in_progress", CYCLE))).toBe(true);
    expect(inReviewPhase(card("in_progress"))).toBe(false);
  });

  it("covers In Review with or without a cycle stamp", () => {
    expect(inReviewPhase(card("in_review", CYCLE))).toBe(true);
    // Pre-migration cards carry no stamp; the lane still answers for them.
    expect(inReviewPhase(card("in_review"))).toBe(true);
  });

  // A stale stamp must never drag a shipped card back into the sweeper's work.
  it("is false past In Review however stale the stamp", () => {
    for (const lane of [
      "qa",
      "customer_approval",
      "ready_for_deployment",
      "post_deploy_validation",
      "done",
      "archived",
    ] as const) {
      expect(inReviewPhase(card(lane, CYCLE))).toBe(false);
    }
  });

  it("is false for a card that has not been worked yet", () => {
    expect(inReviewPhase(card("triage"))).toBe(false);
    expect(inReviewPhase(card("todo"))).toBe(false);
  });
});

describe("dormant lanes", () => {
  it("are refused as a write target, and only they are", () => {
    expect(() => refuseDormantLane("todo")).toThrow(/not on this board/);
    expect(() => refuseDormantLane("approved")).toThrow();
    expect(() => refuseDormantLane("merged")).toThrow();
    expect(() => refuseDormantLane("qa")).not.toThrow();
    expect(() => refuseDormantLane(undefined)).not.toThrow();
  });

  it("are not offered to column rules", () => {
    expect(OFFERED_COLUMN_KEYS).toEqual([
      "triage",
      "in_progress",
      "in_review",
      "qa",
      "customer_approval",
      "ready_for_deployment",
      "post_deploy_validation",
      "done",
      "archived",
    ]);
  });
});

describe("agentMoveRefusal", () => {
  it("refuses a run moving a card forward out of a person's check", () => {
    expect(agentMoveRefusal("qa", "customer_approval")).not.toBeNull();
    expect(agentMoveRefusal("qa", "ready_for_deployment")).not.toBeNull();
    expect(agentMoveRefusal("customer_approval", "done")).not.toBeNull();
  });

  it("refuses a run moving a card into a person's check, or past one", () => {
    expect(agentMoveRefusal("in_review", "qa")).not.toBeNull();
    expect(agentMoveRefusal("in_progress", "customer_approval")).not.toBeNull();
    expect(
      agentMoveRefusal("in_progress", "ready_for_deployment"),
    ).not.toBeNull();
    expect(
      agentMoveRefusal("in_progress", "post_deploy_validation"),
    ).not.toBeNull();
  });

  it("lets a run send a card back from a check, or leave it where it is", () => {
    expect(agentMoveRefusal("qa", "in_progress")).toBeNull();
    expect(agentMoveRefusal("customer_approval", "in_review")).toBeNull();
    expect(agentMoveRefusal("qa", "qa")).toBeNull();
  });

  // A task that needed no change is finished by its own run.
  it("lets a run finish or archive work before the checks", () => {
    expect(agentMoveRefusal("in_progress", "done")).toBeNull();
    expect(agentMoveRefusal("in_progress", "archived")).toBeNull();
    expect(agentMoveRefusal("triage", "in_progress")).toBeNull();
    expect(agentMoveRefusal("in_progress", "in_review")).toBeNull();
  });

  // Validating in production is agent work the user wants to automate.
  it("lets a run finish a card in Post-deploy Validation", () => {
    expect(agentMoveRefusal("post_deploy_validation", "done")).toBeNull();
  });
});
