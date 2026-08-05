import { describe, expect, test } from "bun:test";
import { shouldAdvanceToReview } from "@/storage/task-board";
import { decideStallAction, isNeverStartedRun } from "./stall-recovery";

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

  test("retired linked Decopilot rows continue as hosted", () => {
    expect(
      decideStallAction(ran("failed", { sandboxProviderKind: "user-desktop" })),
    ).toBe("nudge");
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

describe("isNeverStartedRun", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_700_000_000_000;

  /** A thread row as the reaper reads it. */
  const row = (
    overrides: Partial<{
      status: string;
      run_started_at: string | null;
      last_progress_at: string | null;
      updated_at: string;
    }> = {},
  ) =>
    ({
      status: "in_progress",
      run_started_at: null,
      last_progress_at: null,
      updated_at: new Date(now - HOUR).toISOString(),
      ...overrides,
    }) as Parameters<typeof isNeverStartedRun>[0];

  // The exact prod shape: threads written `in_progress` whose run never reached
  // RUN_STARTED, so they are invisible to the in-memory idle reaper on every
  // pod — and one of them freezes its whole card's advance gate.
  test("an in_progress thread that never started and is past the window is reaped", () => {
    expect(isNeverStartedRun(row(), now)).toBe(true);
  });

  test("a run that DID start is left to the idle reaper / DBOS recovery", () => {
    expect(
      isNeverStartedRun(
        row({ run_started_at: new Date(now - HOUR).toISOString() }),
        now,
      ),
    ).toBe(false);
  });

  test("a freshly enqueued run is not reaped — it may still be picked up", () => {
    expect(
      isNeverStartedRun(
        row({ updated_at: new Date(now - 60_000).toISOString() }),
        now,
      ),
    ).toBe(false);
  });

  test("a streaming run keeps itself alive via last_progress_at", () => {
    expect(
      isNeverStartedRun(
        row({ last_progress_at: new Date(now - 60_000).toISOString() }),
        now,
      ),
    ).toBe(false);
  });

  test("only in_progress threads are reaped", () => {
    for (const status of ["completed", "failed", "requires_action"]) {
      expect(isNeverStartedRun(row({ status }), now)).toBe(false);
    }
  });
});
