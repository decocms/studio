import { describe, expect, it } from "bun:test";
import { shouldAdvanceToReview } from "./task-board";

/** A thread that was actually used — the default for these cases. */
const thread = (
  status: string | null,
  hasMessages = true,
): { status: string | null; hasMessages: boolean } => ({
  status,
  hasMessages,
});

/** Created and never typed in: born `completed`, must not count. */
const emptyThread = () => thread("completed", false);

describe("shouldAdvanceToReview", () => {
  it("advances an in_progress, repo-less task whose only thread completed", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("completed")],
      }),
    ).toBe(true);
  });

  // Inverted deliberately: this used to assert that a failed run advances the
  // card. It is how eight tasks whose sandboxes never came up landed In Review
  // with no PR and no work done. In Review means there is something to review.
  it("does NOT advance a task whose only run failed", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("failed")],
      }),
    ).toBe(false);
  });

  it("does NOT advance a task whose only run expired", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("expired")],
      }),
    ).toBe(false);
  });

  // A retry that worked must still reach the reviewers, so the rule is "some run
  // completed", never "the newest one did".
  it("advances when an earlier failure was followed by a completed re-run", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("failed"), thread("completed")],
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
        threads: [thread("completed")],
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

  // Clicking "New chat" persists the row before anything is typed, and `create`
  // defaults status to "completed" — so an empty chat is born terminal. Prod
  // card board_zsKGcXRC9IhyqY_rNHekN sat In Progress on exactly this.
  it("ignores a thread that was created and never used", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [emptyThread()],
      }),
    ).toBe(false);
  });

  it("advances on the used thread, ignoring an empty one beside it", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [emptyThread(), thread("completed")],
      }),
    ).toBe(true);
  });

  it("an empty thread cannot mask a still-running one", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [emptyThread(), thread("in_progress")],
      }),
    ).toBe(false);
  });
});
