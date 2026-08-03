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
    harnessId: string | null;
    sandboxProviderKind: string | null;
  }> = {},
) => ({
  status,
  messageStorageVersion: 2,
  harnessId: "decopilot",
  sandboxProviderKind: "agent-sandbox",
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

  test("failed native, unknown, or unpinned threads are never nudged", () => {
    for (const harnessId of [
      "claude-code",
      "codex",
      "opencode",
      "future",
      null,
    ]) {
      expect(decideStallAction(ran("failed", { harnessId }))).toBe("none");
    }
  });

  test("legacy Decopilot with no sandbox pin remains hosted", () => {
    expect(
      decideStallAction(ran("failed", { sandboxProviderKind: null })),
    ).toBe("nudge");
  });

  test("retired Decopilot desktop rows are never nudged", () => {
    expect(
      decideStallAction(ran("failed", { sandboxProviderKind: "user-desktop" })),
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
