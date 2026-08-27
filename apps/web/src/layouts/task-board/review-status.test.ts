import { describe, expect, it, test } from "bun:test";
import type { TaskBoardActivity } from "@/hooks/use-task-board-activity";
import {
  checksSummary,
  enabledReviewers,
  laneCanShip,
  type ReviewerKind,
  reviewsSatisfiedForPromotion,
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

const act = (
  action: string,
  data: Record<string, unknown>,
  at: string,
): TaskBoardActivity =>
  ({
    id: `a-${at}`,
    taskBoardItemId: "task-1",
    action,
    actorId: null,
    data,
    occurredAt: at,
  }) as unknown as TaskBoardActivity;

const IN_REVIEW = act(
  "status_changed",
  { to: "in_review" },
  "2026-01-01T10:00:00Z",
);

describe("enabledReviewers", () => {
  it("maps the flag to the reviewer list", () => {
    expect(enabledReviewers(true)).toEqual(["reviewer"]);
    expect(enabledReviewers(false)).toEqual([]);
  });
});

describe("reviewsSatisfiedForPromotion", () => {
  it("is ready when no reviewers are enabled (nothing to wait on)", () => {
    expect(reviewsSatisfiedForPromotion([IN_REVIEW], [])).toBe(true);
  });

  it("waits until the enabled reviewer approved this cycle", () => {
    expect(reviewsSatisfiedForPromotion([IN_REVIEW], ENABLED)).toBe(false);
    expect(
      reviewsSatisfiedForPromotion(
        [
          IN_REVIEW,
          act(
            "review_approved",
            { reviewer: "reviewer" },
            "2026-01-01T10:05:00Z",
          ),
        ],
        ENABLED,
      ),
    ).toBe(true);
  });

  it("is not satisfied when the latest verdict is a change request", () => {
    const activity = [
      IN_REVIEW,
      act("review_approved", { reviewer: "reviewer" }, "2026-01-01T10:05:00Z"),
      act(
        "review_changes_requested",
        { reviewer: "reviewer" },
        "2026-01-01T10:06:00Z",
      ),
    ];
    expect(reviewsSatisfiedForPromotion(activity, ENABLED)).toBe(false);
  });

  it("ignores the two-reviewer era's approvals — they are not this reviewer's", () => {
    const activity = [
      IN_REVIEW,
      act("review_approved", { reviewer: "qa" }, "2026-01-01T10:05:00Z"),
      act(
        "review_approved",
        { reviewer: "code_review" },
        "2026-01-01T10:06:00Z",
      ),
    ];
    expect(reviewsSatisfiedForPromotion(activity, ENABLED)).toBe(false);
  });

  it("ignores approvals from a prior review cycle (before the latest In Review)", () => {
    const activity = [
      act("status_changed", { to: "in_review" }, "2026-01-01T09:00:00Z"),
      act("review_approved", { reviewer: "reviewer" }, "2026-01-01T09:05:00Z"),
      // A human re-delegated it, so it re-entered review — the old approve is
      // stale.
      IN_REVIEW,
    ];
    expect(reviewsSatisfiedForPromotion(activity, ENABLED)).toBe(false);
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
  it("offers the button from the two lanes the server accepts", () => {
    expect(laneCanShip("in_review")).toBe(true);
    // The server ships from Approved, so hiding the button there strands the card.
    expect(laneCanShip("approved")).toBe(true);
  });

  it("hides it before review and after the ship", () => {
    for (const lane of [
      "triage",
      "todo",
      "in_progress",
      "merged",
      "post_deploy_validation",
      "done",
      "archived",
    ]) {
      expect(laneCanShip(lane)).toBe(false);
    }
  });
});
