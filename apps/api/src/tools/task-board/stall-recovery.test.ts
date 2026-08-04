import { describe, expect, test } from "bun:test";
import { shouldAdvanceToReview } from "@/storage/task-board";
import { decideStallAction } from "./stall-recovery";

/** A used thread — `shouldAdvanceToReview` filters out message-less ones. */
const thread = (status: string | null, hasMessages = true) => ({
  status,
  hasMessages,
});

/** A thread on the current storage format. */
const ran = (
  status: string | null,
  overrides: Partial<{
    messageStorageVersion: number;
    routingLockedAt: string | null;
    hostedExecutionDisabledAt: string | null;
  }> = {},
) => ({
  status,
  messageStorageVersion: 2,
  routingLockedAt: "2026-08-04T12:00:00.000Z",
  hostedExecutionDisabledAt: null,
  ...overrides,
});

describe("decideStallAction", () => {
  test("a run that finished advances the card", () => {
    expect(decideStallAction(ran("completed"))).toBe("advance");
  });

  test("a run that failed gets nudged, not advanced", () => {
    expect(decideStallAction(ran("failed"))).toBe("nudge");
  });

  test("a v1 thread cannot be nudged — dispatch persists nothing for it", () => {
    expect(decideStallAction(ran("failed", { messageStorageVersion: 1 }))).toBe(
      "none",
    );
  });

  test("a v1 thread that completed still advances", () => {
    expect(
      decideStallAction(ran("completed", { messageStorageVersion: 1 })),
    ).toBe("advance");
  });

  test("non-terminal statuses are never acted on", () => {
    for (const status of ["in_progress", "requires_action", null] as const) {
      expect(decideStallAction(ran(status))).toBe("none");
    }
  });

  test("an unlocked thread is never nudged", () => {
    expect(decideStallAction(ran("failed", { routingLockedAt: null }))).toBe(
      "none",
    );
  });

  test("a retired hosted row is never nudged", () => {
    expect(
      decideStallAction(
        ran("failed", {
          hostedExecutionDisabledAt: "2026-08-04T12:01:00.000Z",
        }),
      ),
    ).toBe("none");
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

  // The one prod straggler: its only thread was created and never typed in.
  test("a card whose only thread is empty is not a candidate", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("completed", false)],
      }),
    ).toBe(false);
  });

  test("only In Progress cards stall", () => {
    for (const status of ["triage", "todo", "in_review", "done"] as const) {
      expect(
        shouldAdvanceToReview({ status, threads: [thread("completed")] }),
      ).toBe(false);
    }
  });
});
