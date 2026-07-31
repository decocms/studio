import { describe, expect, it } from "bun:test";
import type { TaskBoardActivity } from "@/hooks/use-task-board-activity";
import {
  enabledReviewers,
  reviewsSatisfiedForPromotion,
} from "./review-status";

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
