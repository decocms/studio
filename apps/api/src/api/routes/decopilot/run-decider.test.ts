import { describe, expect, it } from "bun:test";
import { decide } from "./run-decider.ts";
import type { RunState } from "./run-state.ts";

// ============================================================================
// Helpers
// ============================================================================

function makeRunningState(overrides?: Partial<RunState>): RunState {
  return {
    taskId: "thread1",
    orgId: "org1",
    userId: "u1",
    status: {
      tag: "running",
      stepCount: 3,
      abortController: new AbortController(),
      startedAt: new Date(),
    },
    ...overrides,
  };
}

function makeRunningStateForThread(taskId: string): RunState {
  return makeRunningState({ taskId });
}

// ============================================================================
// START
// ============================================================================

describe("START", () => {
  it("undefined state → [RUN_STARTED] with correct fields", () => {
    const ac = new AbortController();
    const events = decide(
      {
        type: "START",
        taskId: "t1",
        orgId: "org1",
        userId: "u1",
        abortController: ac,
      },
      undefined,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_STARTED",
      taskId: "t1",
      orgId: "org1",
      userId: "u1",
      abortController: ac,
    });
  });

  it("running state → [PREVIOUS_RUN_ABORTED, RUN_STARTED]", () => {
    const oldState = makeRunningState({ orgId: "org-old", taskId: "t1" });
    const ac = new AbortController();
    const events = decide(
      {
        type: "START",
        taskId: "t1",
        orgId: "org-new",
        userId: "u2",
        abortController: ac,
      },
      oldState,
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "PREVIOUS_RUN_ABORTED",
      taskId: "t1",
      orgId: "org-old",
    });
    expect(events[1]).toEqual({
      type: "RUN_STARTED",
      taskId: "t1",
      orgId: "org-new",
      userId: "u2",
      abortController: ac,
    });
  });
});

// ============================================================================
// STEP_DONE
// ============================================================================

describe("STEP_DONE", () => {
  it("running state (stepCount 3) → [STEP_COMPLETED] with stepCount 4", () => {
    const events = decide(
      { type: "STEP_DONE", taskId: "t1" },
      makeRunningState(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "STEP_COMPLETED",
      taskId: "t1",
      orgId: "org1",
      stepCount: 4,
    });
  });

  it("undefined state → []", () => {
    expect(decide({ type: "STEP_DONE", taskId: "t1" }, undefined)).toEqual([]);
  });
});

// ============================================================================
// FINISH
// ============================================================================

describe("FINISH", () => {
  it('running state + threadStatus "completed" → [RUN_COMPLETED] with correct stepCount and orgId', () => {
    const events = decide(
      { type: "FINISH", taskId: "t1", threadStatus: "completed" },
      makeRunningState(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_COMPLETED",
      taskId: "t1",
      orgId: "org1",
      stepCount: 3,
    });
  });

  it('running state + threadStatus "requires_action" → [RUN_REQUIRES_ACTION] with orgId', () => {
    const events = decide(
      { type: "FINISH", taskId: "t1", threadStatus: "requires_action" },
      makeRunningState(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_REQUIRES_ACTION",
      taskId: "t1",
      orgId: "org1",
      stepCount: 3,
    });
  });

  it('running state + threadStatus "failed" → [RUN_FAILED] with reason "error"', () => {
    const events = decide(
      { type: "FINISH", taskId: "t1", threadStatus: "failed" },
      makeRunningState({ orgId: "org1" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      taskId: "t1",
      orgId: "org1",
      reason: "error",
    });
  });

  it("undefined state → []", () => {
    expect(
      decide(
        { type: "FINISH", taskId: "t1", threadStatus: "completed" },
        undefined,
      ),
    ).toEqual([]);
  });
});

// ============================================================================
// CANCEL
// ============================================================================

describe("CANCEL", () => {
  it("running state → [RUN_FAILED] with reason 'cancelled' and correct orgId", () => {
    const events = decide(
      { type: "CANCEL", taskId: "t1" },
      makeRunningState({ orgId: "org1" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      taskId: "t1",
      orgId: "org1",
      reason: "cancelled",
    });
  });

  it("undefined state → []", () => {
    expect(decide({ type: "CANCEL", taskId: "t1" }, undefined)).toEqual([]);
  });
});

// ============================================================================
// FORCE_FAIL
// ============================================================================

describe("FORCE_FAIL", () => {
  it('running state + reason "ghost" → [RUN_FAILED] with reason "ghost"', () => {
    const events = decide(
      { type: "FORCE_FAIL", taskId: "t1", reason: "ghost", orgId: "org1" },
      makeRunningState({ orgId: "org1" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      taskId: "t1",
      orgId: "org1",
      reason: "ghost",
      // No fence supplied → null (unconditional force-fail; legacy behavior).
      expectedFenceToken: null,
    });
  });

  it("ghost carries expectedFenceToken through to the RUN_FAILED event", () => {
    const events = decide(
      {
        type: "FORCE_FAIL",
        taskId: "t1",
        reason: "ghost",
        orgId: "org1",
        expectedFenceToken: "fence-A",
      },
      makeRunningState({ orgId: "org1" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      taskId: "t1",
      orgId: "org1",
      reason: "ghost",
      // Scopes the reactor's force-fail to the turn being cancelled, so a
      // follow-up turn under a fresh fence is not clobbered.
      expectedFenceToken: "fence-A",
    });
  });

  it('running state + reason "reaped" → [RUN_FAILED] with reason "reaped"', () => {
    const events = decide(
      { type: "FORCE_FAIL", taskId: "t1", reason: "reaped" },
      makeRunningState({ orgId: "org1" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      taskId: "t1",
      orgId: "org1",
      reason: "reaped",
    });
  });

  it("ghost + undefined state + orgId → [RUN_FAILED] with reason 'ghost' (B1 fix)", () => {
    const events = decide(
      { type: "FORCE_FAIL", taskId: "t1", reason: "ghost", orgId: "org1" },
      undefined,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      taskId: "t1",
      orgId: "org1",
      reason: "ghost",
      expectedFenceToken: null,
    });
  });

  it("reaped + undefined state → [] (non-ghost is a no-op when no in-memory state)", () => {
    expect(
      decide({ type: "FORCE_FAIL", taskId: "t1", reason: "reaped" }, undefined),
    ).toEqual([]);
  });
});

// ============================================================================
// RESUME
// ============================================================================

describe("RESUME", () => {
  it("emits RUN_RESUMED when no existing state", () => {
    const ac = new AbortController();
    const events = decide(
      {
        type: "RESUME",
        taskId: "t1",
        orgId: "org1",
        userId: "u1",
        abortController: ac,
        podId: "pod-1",
      },
      undefined,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("RUN_RESUMED");
    expect(events[0]).toMatchObject({
      taskId: "t1",
      orgId: "org1",
      userId: "u1",
      podId: "pod-1",
    });
  });

  it("returns [] when already running (idempotent)", () => {
    const events = decide(
      {
        type: "RESUME",
        taskId: "t1",
        orgId: "org1",
        userId: "u1",
        abortController: new AbortController(),
        podId: "pod-1",
      },
      makeRunningStateForThread("t1"),
    );
    expect(events).toEqual([]);
  });
});
