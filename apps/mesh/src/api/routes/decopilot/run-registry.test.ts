import { describe, it, expect, mock } from "bun:test";
import { RunRegistry } from "./run-registry";
import type { StreamBuffer } from "./stream-buffer";
import type { RunReactorDeps } from "./run-reactor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNoopDeps(): RunReactorDeps {
  return {
    storage: {
      update: mock(() => Promise.resolve({} as never)),
      create: mock(() => Promise.resolve({} as never)),
      get: mock(() => Promise.resolve(null)),
      delete: mock(() => Promise.resolve()),
      list: mock(() => Promise.resolve({ threads: [], total: 0 })),
      saveMessages: mock(() => Promise.resolve()),
      listMessages: mock(() => Promise.resolve({ messages: [], total: 0 })),
      forceFailIfInProgress: mock(() => Promise.resolve(false)),
    },
    streamBuffer: { purge: mock(() => {}) } as unknown as StreamBuffer,
    sseHub: { emit: mock(() => {}) },
  };
}

/** Create a registry backed by no-op mocks. */
function createRegistry() {
  return new RunRegistry(makeNoopDeps());
}

/** Dispatch a START command for a given thread and return the registry. */
function startThread(
  registry: RunRegistry,
  threadId: string,
  orgId = "org1",
  userId = "u1",
) {
  return registry.dispatch({
    type: "START",
    threadId,
    orgId,
    userId,
    abortController: new AbortController(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RunRegistry", () => {
  // -------------------------------------------------------------------------
  // dispatch START
  // -------------------------------------------------------------------------
  describe("dispatch START", () => {
    it("returns a RUN_STARTED pair and marks the thread running", () => {
      const registry = createRegistry();
      const pairs = startThread(registry, "t1");

      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.event.type).toBe("RUN_STARTED");
      expect(pairs[0]!.state?.status.tag).toBe("running");
      expect(registry.isRunning("t1")).toBe(true);
      expect(registry.getAbortSignal("t1")).not.toBeNull();
    });

    it("emits [PREVIOUS_RUN_ABORTED, RUN_STARTED] when thread is already running", () => {
      const registry = createRegistry();
      startThread(registry, "t1");

      // Capture the first run's signal before overwriting
      const firstSignal = registry.getAbortSignal("t1")!;

      const pairs = startThread(registry, "t1");

      expect(pairs).toHaveLength(2);
      expect(pairs[0]!.event.type).toBe("PREVIOUS_RUN_ABORTED");
      expect(pairs[1]!.event.type).toBe("RUN_STARTED");

      // Old AbortController must have been aborted
      expect(firstSignal.aborted).toBe(true);

      // New signal comes from the fresh AbortController
      const newSignal = registry.getAbortSignal("t1");
      expect(newSignal).not.toBeNull();
      expect(newSignal).not.toBe(firstSignal);
    });
  });

  // -------------------------------------------------------------------------
  // dispatch CANCEL
  // -------------------------------------------------------------------------
  describe("dispatch CANCEL", () => {
    it("returns RUN_FAILED and stops the run when running", () => {
      const registry = createRegistry();
      startThread(registry, "t1");

      const pairs = registry.dispatch({ type: "CANCEL", threadId: "t1" });

      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.event.type).toBe("RUN_FAILED");
      if (pairs[0]!.event.type === "RUN_FAILED") {
        expect(pairs[0]!.event.reason).toBe("cancelled");
      }
      expect(registry.isRunning("t1")).toBe(false);
    });

    it("aborts the AbortController on CANCEL", () => {
      const registry = createRegistry();
      startThread(registry, "t1");
      const signal = registry.getAbortSignal("t1")!;

      registry.dispatch({ type: "CANCEL", threadId: "t1" });

      expect(signal.aborted).toBe(true);
    });

    it("returns empty array for a non-running thread", () => {
      const registry = createRegistry();
      const pairs = registry.dispatch({ type: "CANCEL", threadId: "t1" });
      expect(pairs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // dispatch FINISH
  // -------------------------------------------------------------------------
  describe("dispatch FINISH", () => {
    it("emits RUN_COMPLETED when threadStatus is 'completed'", () => {
      const registry = createRegistry();
      startThread(registry, "t1");

      const pairs = registry.dispatch({
        type: "FINISH",
        threadId: "t1",
        threadStatus: "completed",
      });

      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.event.type).toBe("RUN_COMPLETED");
      expect(registry.isRunning("t1")).toBe(false);
    });

    it("emits RUN_REQUIRES_ACTION when threadStatus is 'requires_action'", () => {
      const registry = createRegistry();
      startThread(registry, "t1");

      const pairs = registry.dispatch({
        type: "FINISH",
        threadId: "t1",
        threadStatus: "requires_action",
      });

      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.event.type).toBe("RUN_REQUIRES_ACTION");
      expect(registry.isRunning("t1")).toBe(false);
    });

    it("emits RUN_FAILED when threadStatus is 'failed'", () => {
      const registry = createRegistry();
      startThread(registry, "t1");

      const pairs = registry.dispatch({
        type: "FINISH",
        threadId: "t1",
        threadStatus: "failed",
      });

      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.event.type).toBe("RUN_FAILED");
      expect(registry.isRunning("t1")).toBe(false);
    });

    it("returns empty array (idempotent) when thread is not running", () => {
      const registry = createRegistry();
      const pairs = registry.dispatch({
        type: "FINISH",
        threadId: "t1",
        threadStatus: "completed",
      });
      expect(pairs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // dispatch FORCE_FAIL
  // -------------------------------------------------------------------------
  describe("dispatch FORCE_FAIL", () => {
    it("emits RUN_FAILED with reason 'reaped' when running", () => {
      const registry = createRegistry();
      startThread(registry, "t1");

      const pairs = registry.dispatch({
        type: "FORCE_FAIL",
        threadId: "t1",
        reason: "reaped",
      });

      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.event.type).toBe("RUN_FAILED");
      if (pairs[0]!.event.type === "RUN_FAILED") {
        expect(pairs[0]!.event.reason).toBe("reaped");
      }
      expect(registry.isRunning("t1")).toBe(false);
    });

    it("aborts the AbortController on FORCE_FAIL", () => {
      const registry = createRegistry();
      startThread(registry, "t1");
      const signal = registry.getAbortSignal("t1")!;

      registry.dispatch({
        type: "FORCE_FAIL",
        threadId: "t1",
        reason: "reaped",
      });

      expect(signal.aborted).toBe(true);
    });

    it("emits RUN_FAILED with reason 'ghost' even when no in-memory state exists", () => {
      const registry = createRegistry();

      const pairs = registry.dispatch({
        type: "FORCE_FAIL",
        threadId: "t1",
        reason: "ghost",
        orgId: "org1",
      });

      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.event.type).toBe("RUN_FAILED");
      if (pairs[0]!.event.type === "RUN_FAILED") {
        expect(pairs[0]!.event.reason).toBe("ghost");
        expect(pairs[0]!.event.orgId).toBe("org1");
      }
    });

    it("returns empty array for non-running thread when reason is 'reaped'", () => {
      const registry = createRegistry();
      const pairs = registry.dispatch({
        type: "FORCE_FAIL",
        threadId: "t1",
        reason: "reaped",
      });
      expect(pairs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // dispatch STEP_DONE
  // -------------------------------------------------------------------------
  describe("dispatch STEP_DONE", () => {
    it("emits STEP_COMPLETED with incremented stepCount when running", () => {
      const registry = createRegistry();
      startThread(registry, "t1");

      const pairs = registry.dispatch({ type: "STEP_DONE", threadId: "t1" });

      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.event.type).toBe("STEP_COMPLETED");
      if (pairs[0]!.event.type === "STEP_COMPLETED") {
        expect(pairs[0]!.event.stepCount).toBe(1);
      }
    });

    it("returns empty array when thread is not running", () => {
      const registry = createRegistry();
      const pairs = registry.dispatch({ type: "STEP_DONE", threadId: "t1" });
      expect(pairs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getAbortSignal
  // -------------------------------------------------------------------------
  describe("getAbortSignal", () => {
    it("returns null for an unknown threadId", () => {
      const registry = createRegistry();
      expect(registry.getAbortSignal("nope")).toBeNull();
    });

    it("returns null after a run finishes", () => {
      const registry = createRegistry();
      startThread(registry, "t1");

      registry.dispatch({
        type: "FINISH",
        threadId: "t1",
        threadStatus: "completed",
      });

      expect(registry.getAbortSignal("t1")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // stopAll
  // -------------------------------------------------------------------------
  describe("stopAll", () => {
    it("aborts running entries, calls storage.update for each, and clears the map", () => {
      const deps = makeNoopDeps();
      const registry = new RunRegistry(deps);

      startThread(registry, "t1", "org1", "u1");
      startThread(registry, "t2", "org1", "u2");

      const signalT1 = registry.getAbortSignal("t1")!;
      const signalT2 = registry.getAbortSignal("t2")!;

      // Start a third run and finish it so it is no longer "running"
      startThread(registry, "t3", "org1", "u3");
      registry.dispatch({
        type: "FINISH",
        threadId: "t3",
        threadStatus: "completed",
      });

      registry.stopAll();

      expect(signalT1.aborted).toBe(true);
      expect(signalT2.aborted).toBe(true);

      expect(deps.storage.update).toHaveBeenCalledTimes(2);
      expect(deps.storage.update).toHaveBeenCalledWith("t1", {
        status: "failed",
      });
      expect(deps.storage.update).toHaveBeenCalledWith("t2", {
        status: "failed",
      });

      expect(registry.isRunning("t1")).toBe(false);
      expect(registry.isRunning("t2")).toBe(false);
    });
  });
});
