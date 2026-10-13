/**
 * The lane order and the questions that ride on it.
 *
 * These are the assertions that make "automation never drags a card backward"
 * a checkable fact rather than a property several call sites happen to agree
 * on.
 */

import { describe, expect, it } from "bun:test";
import type { TaskBoardItemStatus } from "@/storage/types";
import {
  inReviewPhase,
  isTaggableMergedStatus,
  LANE_RANK,
  laneRank,
  movesForward,
} from "./lanes";

const BOARD_ORDER: TaskBoardItemStatus[] = [
  "triage",
  "in_progress",
  "in_review",
  "qa",
  "customer_approval",
  "ready_for_deployment",
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
  it("covers the lanes a merged PR leaves a card in", () => {
    for (const lane of ["post_deploy_validation", "done"]) {
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
  });
});
