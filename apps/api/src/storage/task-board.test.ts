import { describe, expect, it } from "bun:test";
import { shouldAdvanceToReview } from "./task-board";

const thread = (
  status: string | null,
  hasPreview = false,
): { status: string | null; hasPreview: boolean } => ({ status, hasPreview });

describe("shouldAdvanceToReview", () => {
  it("advances an in_progress, repo-less task whose only thread completed", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("completed")],
      }),
    ).toBe(true);
  });

  it("treats a failed run as finished (still advances)", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("failed")],
      }),
    ).toBe(true);
  });

  it("requires EVERY thread to be terminal", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("completed"), thread("in_progress")],
      }),
    ).toBe(false);
  });

  it("does not advance while a thread is paused on user_ask (requires_action)", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("requires_action")],
      }),
    ).toBe(false);
  });

  it("advances a repo-backed task on thread-finish too (backstop for missed PR detection)", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("completed", true)],
      }),
    ).toBe(true);
  });

  it("only fires from in_progress, not from other lanes", () => {
    for (const status of ["triage", "todo", "in_review", "done"] as const) {
      expect(
        shouldAdvanceToReview({ status, threads: [thread("completed")] }),
      ).toBe(false);
    }
  });

  it("does not advance a task with no threads", () => {
    expect(shouldAdvanceToReview({ status: "in_progress", threads: [] })).toBe(
      false,
    );
  });
});
