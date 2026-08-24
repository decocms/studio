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

const BOTH: ReviewerKind[] = ["qa", "code_review"];

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
  it("maps the two flags to the reviewer list", () => {
    expect(enabledReviewers({ qa: true, codeReview: true })).toEqual([
      "qa",
      "code_review",
    ]);
    expect(enabledReviewers({ qa: false, codeReview: true })).toEqual([
      "code_review",
    ]);
    expect(enabledReviewers({ qa: false, codeReview: false })).toEqual([]);
  });
});

describe("reviewsSatisfiedForPromotion", () => {
  it("is ready when no reviewers are enabled (nothing to wait on)", () => {
    expect(reviewsSatisfiedForPromotion([IN_REVIEW], [])).toBe(true);
  });

  it("waits until every enabled reviewer approved this cycle", () => {
    const activity = [
      IN_REVIEW,
      act("review_approved", { reviewer: "qa" }, "2026-01-01T10:05:00Z"),
    ];
    expect(reviewsSatisfiedForPromotion(activity, ["qa", "code_review"])).toBe(
      false,
    );
    activity.push(
      act(
        "review_approved",
        { reviewer: "code_review" },
        "2026-01-01T10:06:00Z",
      ),
    );
    expect(reviewsSatisfiedForPromotion(activity, ["qa", "code_review"])).toBe(
      true,
    );
  });

  it("is not satisfied when a reviewer's latest verdict is a change request", () => {
    const activity = [
      IN_REVIEW,
      act("review_approved", { reviewer: "qa" }, "2026-01-01T10:05:00Z"),
      act(
        "review_changes_requested",
        { reviewer: "code_review" },
        "2026-01-01T10:06:00Z",
      ),
    ];
    expect(reviewsSatisfiedForPromotion(activity, ["qa", "code_review"])).toBe(
      false,
    );
  });

  it("ignores approvals from a prior review cycle (before the latest In Review)", () => {
    const activity = [
      act("status_changed", { to: "in_review" }, "2026-01-01T09:00:00Z"),
      act("review_approved", { reviewer: "qa" }, "2026-01-01T09:05:00Z"),
      // A change request bounced it, then it re-entered review — the old approve
      // is stale.
      IN_REVIEW,
    ];
    expect(reviewsSatisfiedForPromotion(activity, ["qa"])).toBe(false);
  });
});

describe("checksSummary", () => {
  test("an org with no reviewers has no checks to show", () => {
    expect(checksSummary([], [])).toBeNull();
    expect(checksSummary([approved("qa")], [])).toBeNull();
  });

  test("nothing decided yet reads as danger, not pending", () => {
    expect(checksSummary([], BOTH)).toEqual({
      passed: 0,
      total: 2,
      tone: "danger",
    });
  });

  test("one of two approved is pending", () => {
    expect(checksSummary([approved("qa")], BOTH)).toEqual({
      passed: 1,
      total: 2,
      tone: "pending",
    });
  });

  test("an outstanding change request is danger even at 1/2", () => {
    expect(
      checksSummary([approved("qa"), rejected("code_review")], BOTH),
    ).toEqual({ passed: 1, total: 2, tone: "danger" });
  });

  test("every reviewer approved and verified is ok", () => {
    expect(
      checksSummary([approved("qa"), approved("code_review")], BOTH),
    ).toEqual({ passed: 2, total: 2, tone: "ok" });
  });

  // Inverted: an earlier cut held this at `pending`, so the chip contradicted
  // its own number. Verification is a separate question, and lives in the tooltip.
  test("a full set of approvals is ok even when one is unverified", () => {
    expect(
      checksSummary([approved("qa", false), approved("code_review")], BOTH),
    ).toEqual({ passed: 2, total: 2, tone: "ok" });
  });

  test("a disabled reviewer's verdict is ignored entirely", () => {
    const only: ReviewerKind[] = ["code_review"];
    // QA is off: its approval must not count toward the total...
    expect(
      checksSummary([approved("qa"), approved("code_review")], only),
    ).toEqual({ passed: 1, total: 1, tone: "ok" });
    // ...and its change request must not hold the card back.
    expect(
      checksSummary([rejected("qa"), approved("code_review")], only),
    ).toEqual({ passed: 1, total: 1, tone: "ok" });
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
