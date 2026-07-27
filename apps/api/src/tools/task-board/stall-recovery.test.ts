import { describe, expect, test } from "bun:test";
import { shouldAdvanceToReview } from "@/storage/task-board";
import { decideStallAction } from "./stall-recovery";

const thread = (status: string | null) => ({ status, hasPreview: false });

/** A thread that actually ran, on the current storage format. */
const ran = (status: string) => ({
  status,
  hasHistory: true,
  messageStorageVersion: 2,
});

describe("decideStallAction", () => {
  test("a run that finished advances the card", () => {
    expect(decideStallAction(ran("completed"))).toBe("advance");
  });

  test("a run that failed gets nudged, not advanced", () => {
    expect(decideStallAction(ran("failed"))).toBe("nudge");
  });

  // Regression: ThreadStorage.create defaults status to "completed", so an empty
  // chat opened next to a card is born terminal. Prod board_zsKGcXRC9IhyqY_rNHekN
  // is exactly this — 0 parts, 0 v1 messages, updated_at == created_at — and
  // advancing it would mark work reviewable that nobody ever started.
  test("a thread born completed with no history is left alone", () => {
    expect(
      decideStallAction({
        status: "completed",
        hasHistory: false,
        messageStorageVersion: 1,
      }),
    ).toBe("none");
  });

  test("a v1 thread cannot be nudged — dispatch persists nothing for it", () => {
    expect(
      decideStallAction({
        status: "failed",
        hasHistory: true,
        messageStorageVersion: 1,
      }),
    ).toBe("none");
  });

  test("a v1 thread that completed still advances", () => {
    expect(
      decideStallAction({
        status: "completed",
        hasHistory: true,
        messageStorageVersion: 1,
      }),
    ).toBe("advance");
  });

  test("non-terminal statuses are never acted on", () => {
    for (const status of ["in_progress", "requires_action", null] as const) {
      expect(
        decideStallAction({
          status,
          hasHistory: true,
          messageStorageVersion: 2,
        }),
      ).toBe("none");
    }
  });
});

// The board-open sweep narrows with this before reading any thread state, so
// these cases must never reach decideStallAction at all.
describe("shouldAdvanceToReview gates the sweep", () => {
  test("all threads terminal → candidate", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("completed"), thread("failed")],
      }),
    ).toBe(true);
  });

  test("a thread parked on user_ask is a human's problem", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("requires_action"), thread("completed")],
      }),
    ).toBe(false);
  });

  test("a live run is left alone", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("in_progress")],
      }),
    ).toBe(false);
  });

  // The 18 In Progress cards in prod with no linked thread are humans working.
  test("no linked thread → never touched", () => {
    expect(shouldAdvanceToReview({ status: "in_progress", threads: [] })).toBe(
      false,
    );
  });

  test("only In Progress cards stall", () => {
    for (const status of ["triage", "todo", "in_review", "done"] as const) {
      expect(
        shouldAdvanceToReview({ status, threads: [thread("completed")] }),
      ).toBe(false);
    }
  });
});
