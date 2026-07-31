/**
 * Regression coverage for `isReadyToShip`: the server-side gate that
 * `TASK_BOARD_PROMOTE_TO_PRODUCTION` must enforce so a caller can't merge a
 * task's PR before it's actually In Review with every enabled reviewer
 * approved — the board's "Ship to production" button only shows in that
 * state, but the tool itself used to trust the caller, not the task's status.
 */
import { describe, expect, it } from "bun:test";
import type { ReviewCycleActivity } from "@decocms/shared/task-board";
import { isReadyToShip } from "./promote-to-production";

function approved(reviewer: "qa" | "code_review"): ReviewCycleActivity {
  return {
    action: "review_approved",
    data: { reviewer },
    occurredAt: "2026-01-01T00:01:00.000Z",
  };
}

describe("isReadyToShip", () => {
  it("rejects a task that never entered review, even with no reviewers enabled", () => {
    expect(isReadyToShip("todo", [], [])).toBe(false);
    expect(isReadyToShip("in_progress", [], [])).toBe(false);
  });

  it("allows an in_review task straight through when no reviewers are enabled", () => {
    expect(isReadyToShip("in_review", [], [])).toBe(true);
  });

  it("rejects an in_review task while a required reviewer hasn't approved", () => {
    expect(
      isReadyToShip("in_review", [approved("qa")], ["qa", "code_review"]),
    ).toBe(false);
  });

  it("allows an in_review task once every enabled reviewer approved", () => {
    expect(
      isReadyToShip(
        "in_review",
        [approved("qa"), approved("code_review")],
        ["qa", "code_review"],
      ),
    ).toBe(true);
  });
});
