import { describe, expect, it } from "bun:test";
import { decide } from "./run-decider.ts";
import type { RunState } from "./run-state.ts";

// ============================================================================
// Helpers
// ============================================================================

function makeRunningState(overrides?: Partial<RunState>): RunState {
  return {
    threadId: "thread1",
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

// ============================================================================
// START
// ============================================================================

describe("START", () => {
  it("undefined state → [RUN_STARTED] with correct fields", () => {
    const ac = new AbortController();
    const events = decide(
      {
        type: "START",
        threadId: "t1",
        orgId: "org1",
        userId: "u1",
        abortController: ac,
      },
      undefined,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_STARTED",
      threadId: "t1",
      orgId: "org1",
      userId: "u1",
      abortController: ac,
    });
  });

  it("running state → [PREVIOUS_RUN_ABORTED, RUN_STARTED]", () => {
    const oldState = makeRunningState({ orgId: "org-old", threadId: "t1" });
    const ac = new AbortController();
    const events = decide(
      {
        type: "START",
        threadId: "t1",
        orgId: "org-new",
        userId: "u2",
        abortController: ac,
      },
      oldState,
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "PREVIOUS_RUN_ABORTED",
      threadId: "t1",
      orgId: "org-old",
    });
    expect(events[1]).toEqual({
      type: "RUN_STARTED",
      threadId: "t1",
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
      { type: "STEP_DONE", threadId: "t1" },
      makeRunningState(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "STEP_COMPLETED",
      threadId: "t1",
      orgId: "org1",
      stepCount: 4,
    });
  });

  it("undefined state → []", () => {
    expect(decide({ type: "STEP_DONE", threadId: "t1" }, undefined)).toEqual(
      [],
    );
  });
});

// ============================================================================
// FINISH
// ============================================================================

describe("FINISH", () => {
  it('running state + threadStatus "completed" → [RUN_COMPLETED] with correct stepCount and orgId', () => {
    const events = decide(
      { type: "FINISH", threadId: "t1", threadStatus: "completed" },
      makeRunningState(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_COMPLETED",
      threadId: "t1",
      orgId: "org1",
      stepCount: 3,
    });
  });

  it('running state + threadStatus "requires_action" → [RUN_REQUIRES_ACTION] with orgId', () => {
    const events = decide(
      { type: "FINISH", threadId: "t1", threadStatus: "requires_action" },
      makeRunningState(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_REQUIRES_ACTION",
      threadId: "t1",
      orgId: "org1",
      stepCount: 3,
    });
  });

  it('running state + threadStatus "failed" → [RUN_FAILED] with reason "error"', () => {
    const events = decide(
      { type: "FINISH", threadId: "t1", threadStatus: "failed" },
      makeRunningState({ orgId: "org1" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      threadId: "t1",
      orgId: "org1",
      reason: "error",
    });
  });

  it("undefined state → []", () => {
    expect(
      decide(
        { type: "FINISH", threadId: "t1", threadStatus: "completed" },
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
      { type: "CANCEL", threadId: "t1" },
      makeRunningState({ orgId: "org1" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      threadId: "t1",
      orgId: "org1",
      reason: "cancelled",
    });
  });

  it("undefined state → []", () => {
    expect(decide({ type: "CANCEL", threadId: "t1" }, undefined)).toEqual([]);
  });
});

// ============================================================================
// FORCE_FAIL
// ============================================================================

describe("FORCE_FAIL", () => {
  it('running state + reason "ghost" → [RUN_FAILED] with reason "ghost"', () => {
    const events = decide(
      { type: "FORCE_FAIL", threadId: "t1", reason: "ghost", orgId: "org1" },
      makeRunningState({ orgId: "org1" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      threadId: "t1",
      orgId: "org1",
      reason: "ghost",
    });
  });

  it('running state + reason "reaped" → [RUN_FAILED] with reason "reaped"', () => {
    const events = decide(
      { type: "FORCE_FAIL", threadId: "t1", reason: "reaped" },
      makeRunningState({ orgId: "org1" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      threadId: "t1",
      orgId: "org1",
      reason: "reaped",
    });
  });

  it("ghost + undefined state + orgId → [RUN_FAILED] with reason 'ghost' (B1 fix)", () => {
    const events = decide(
      { type: "FORCE_FAIL", threadId: "t1", reason: "ghost", orgId: "org1" },
      undefined,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "RUN_FAILED",
      threadId: "t1",
      orgId: "org1",
      reason: "ghost",
    });
  });

  it("reaped + undefined state → [] (non-ghost is a no-op when no in-memory state)", () => {
    expect(
      decide(
        { type: "FORCE_FAIL", threadId: "t1", reason: "reaped" },
        undefined,
      ),
    ).toEqual([]);
  });
});
