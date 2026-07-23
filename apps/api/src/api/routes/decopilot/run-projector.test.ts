import { describe, expect, it } from "bun:test";
import { project } from "./run-projector.ts";
import type { RunEvent, RunState } from "./run-state.ts";

function makeRunningState(stepCount = 3): RunState {
  return {
    taskId: "t1",
    orgId: "org1",
    userId: "u1",
    status: {
      tag: "running",
      abortController: new AbortController(),
      stepCount,
      startedAt: new Date(),
    },
  };
}

function makeRunStartedEvent(): Extract<RunEvent, { type: "RUN_STARTED" }> {
  return {
    type: "RUN_STARTED",
    taskId: "t1",
    orgId: "org1",
    userId: "u1",
    abortController: new AbortController(),
  };
}

describe("project", () => {
  describe("RUN_STARTED", () => {
    it("undefined state → RunState with tag running, stepCount 0, abortController from event", () => {
      const event = makeRunStartedEvent();
      const fixedNow = new Date("2024-01-01T00:00:00Z");
      const result = project(undefined, event, fixedNow);
      expect(result).not.toBeUndefined();
      expect(result!.status.tag).toBe("running");
      expect(result!.taskId).toBe("t1");
      expect(result!.orgId).toBe("org1");
      expect(result!.userId).toBe("u1");
      if (result!.status.tag === "running") {
        expect(result!.status.stepCount).toBe(0);
        expect(result!.status.abortController).toBe(event.abortController);
        expect(result!.status.startedAt).toBe(fixedNow);
      }
    });

    it("startedAt uses the injected clock, not wall time", () => {
      const event = makeRunStartedEvent();
      const fixedNow = new Date("2020-06-15T12:00:00Z");
      const result = project(undefined, event, fixedNow);
      if (result?.status.tag === "running") {
        expect(result.status.startedAt).toBe(fixedNow);
      } else {
        throw new Error("Expected running state");
      }
    });

    it("running state (restart) → RunState with new identity fields from event, stepCount 0", () => {
      const existing = makeRunningState(5);
      const event: Extract<RunEvent, { type: "RUN_STARTED" }> = {
        type: "RUN_STARTED",
        taskId: "t-new",
        orgId: "org-new",
        userId: "u-new",
        abortController: new AbortController(),
      };
      const result = project(existing, event, new Date());
      expect(result).not.toBeUndefined();
      expect(result!.taskId).toBe("t-new");
      expect(result!.orgId).toBe("org-new");
      expect(result!.userId).toBe("u-new");
      expect(result!.status.tag).toBe("running");
      if (result!.status.tag === "running") {
        expect(result!.status.stepCount).toBe(0);
        expect(result!.status.abortController).toBe(event.abortController);
      }
    });

    it("preserves exact abortController instance from event (reference equality)", () => {
      const event = makeRunStartedEvent();
      const result = project(undefined, event, new Date());
      if (result?.status.tag === "running") {
        expect(result.status.abortController).toBe(event.abortController);
      } else {
        throw new Error("Expected running state");
      }
    });
  });

  describe("RUN_RESUMED", () => {
    it("creates running state with stepCount 0 and clock time", () => {
      const ac = new AbortController();
      const now = new Date("2024-01-01T00:00:00Z");
      const state = project(
        undefined,
        {
          type: "RUN_RESUMED",
          taskId: "t1",
          orgId: "org1",
          userId: "u1",
          abortController: ac,
          podId: "pod-1",
        },
        now,
      );
      expect(state).toEqual({
        taskId: "t1",
        orgId: "org1",
        userId: "u1",
        status: {
          tag: "running",
          abortController: ac,
          stepCount: 0,
          startedAt: now,
        },
      });
    });
  });

  describe("STEP_COMPLETED", () => {
    it("running state → tag still running, stepCount updated", () => {
      const state = makeRunningState(3);
      const result = project(state, {
        type: "STEP_COMPLETED",
        taskId: "t1",
        orgId: "org1",
        stepCount: 4,
      });
      expect(result?.status.tag).toBe("running");
      if (result?.status.tag === "running") {
        expect(result.status.stepCount).toBe(4);
      }
    });

    it("undefined state → returns undefined (defensive)", () => {
      const result = project(undefined, {
        type: "STEP_COMPLETED",
        taskId: "t1",
        orgId: "org1",
        stepCount: 4,
      });
      expect(result).toBeUndefined();
    });
  });

  describe("RUN_COMPLETED", () => {
    it("running state → undefined (evicted from Map; orgId carried on event)", () => {
      const state = makeRunningState(3);
      const result = project(state, {
        type: "RUN_COMPLETED",
        taskId: "t1",
        orgId: "org1",
        stepCount: 7,
      });
      expect(result).toBeUndefined();
    });

    it("undefined state → undefined", () => {
      const result = project(undefined, {
        type: "RUN_COMPLETED",
        taskId: "t1",
        orgId: "org1",
        stepCount: 7,
      });
      expect(result).toBeUndefined();
    });
  });

  describe("RUN_REQUIRES_ACTION", () => {
    it("running state → undefined (evicted from Map; orgId carried on event)", () => {
      const state = makeRunningState(2);
      const result = project(state, {
        type: "RUN_REQUIRES_ACTION",
        taskId: "t1",
        orgId: "org1",
        stepCount: 8,
      });
      expect(result).toBeUndefined();
    });

    it("undefined state → undefined", () => {
      const result = project(undefined, {
        type: "RUN_REQUIRES_ACTION",
        taskId: "t1",
        orgId: "org1",
        stepCount: 8,
      });
      expect(result).toBeUndefined();
    });
  });

  describe("RUN_FAILED", () => {
    it("running state → undefined (run removed)", () => {
      const state = makeRunningState();
      const result = project(state, {
        type: "RUN_FAILED",
        taskId: "t1",
        orgId: "org1",
        reason: "error",
      });
      expect(result).toBeUndefined();
    });

    it("undefined state → undefined", () => {
      const result = project(undefined, {
        type: "RUN_FAILED",
        taskId: "t1",
        orgId: "org1",
        reason: "error",
      });
      expect(result).toBeUndefined();
    });
  });

  describe("PREVIOUS_RUN_ABORTED", () => {
    it("running state → undefined", () => {
      const state = makeRunningState();
      const result = project(state, {
        type: "PREVIOUS_RUN_ABORTED",
        taskId: "t1",
        orgId: "org1",
      });
      expect(result).toBeUndefined();
    });

    it("undefined state → undefined", () => {
      const result = project(undefined, {
        type: "PREVIOUS_RUN_ABORTED",
        taskId: "t1",
        orgId: "org1",
      });
      expect(result).toBeUndefined();
    });
  });
});
