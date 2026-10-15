import { describe, expect, it, test } from "bun:test";
import {
  checksSummary,
  enabledReviewers,
  laneCanShip,
  type ReviewerKind,
} from "./review-status";
import type { TaskBoardItem } from "./config";

type Verdict = TaskBoardItem["reviewVerdicts"][number];

const approved = (reviewer: ReviewerKind, verified = true): Verdict => ({
  reviewer,
  verdict: "approved",
  verified,
});

const rejected = (reviewer: ReviewerKind): Verdict => ({
  reviewer,
  verdict: "changes_requested",
  verified: false,
});

const ENABLED: ReviewerKind[] = ["reviewer"];

describe("enabledReviewers", () => {
  it("maps the flag to the reviewer list", () => {
    expect(enabledReviewers(true)).toEqual(["reviewer"]);
    expect(enabledReviewers(false)).toEqual([]);
  });
});

describe("checksSummary", () => {
  test("an org with no reviewers has no checks to show", () => {
    expect(checksSummary([], [])).toBeNull();
    expect(checksSummary([approved("reviewer")], [])).toBeNull();
  });

  test("nothing decided yet reads as danger, not pending", () => {
    expect(checksSummary([], ENABLED)).toEqual({
      passed: 0,
      total: 1,
      tone: "danger",
    });
  });

  test("an outstanding change request is danger", () => {
    expect(checksSummary([rejected("reviewer")], ENABLED)).toEqual({
      passed: 0,
      total: 1,
      tone: "danger",
    });
  });

  test("approved and verified is ok", () => {
    expect(checksSummary([approved("reviewer")], ENABLED)).toEqual({
      passed: 1,
      total: 1,
      tone: "ok",
    });
  });

  // Inverted: an earlier cut held this at `pending`, so the chip contradicted
  // its own number. Verification is a separate question, and lives in the tooltip.
  test("a full set of approvals is ok even when unverified", () => {
    expect(checksSummary([approved("reviewer", false)], ENABLED)).toEqual({
      passed: 1,
      total: 1,
      tone: "ok",
    });
  });
});

describe("laneCanShip", () => {
  it("offers the button only from Ready for Deployment", () => {
    expect(laneCanShip("ready_for_deployment")).toBe(true);
  });

  // In Review and Approved used to ship. Neither does now: a merge waits for
  // QA and Customer Approval, and Approved is a dormant lane.
  it("hides it everywhere else", () => {
    for (const lane of [
      "triage",
      "todo",
      "in_progress",
      "in_review",
      "qa",
      "customer_approval",
      "approved",
      "merged",
      "post_deploy_validation",
      "done",
      "archived",
    ]) {
      expect(laneCanShip(lane)).toBe(false);
    }
  });
});
