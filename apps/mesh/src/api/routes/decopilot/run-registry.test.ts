import { afterEach, describe, expect, it } from "bun:test";
import { RunRegistry } from "./run-registry";
import type { StreamBuffer } from "./stream-buffer";
import type { RunReactorDeps } from "./run-reactor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inert deps for the *pure* state-machine tests below.
 *
 * Everything in this file exercises only the in-memory half of RunRegistry —
 * the `states` Map, the AbortController lifecycle, and the reaper's timing
 * decision. None of these code paths read from storage, so this object is
 * unexercised scaffolding required by the constructor, not a faked input that
 * any assertion depends on. (Per TESTING.md, the forbidden thing is faking a
 * dependency whose output drives the behavior under test — an unused
 * collaborator is not that.)
 *
 * The storage-orchestrating methods (stopAll, recoverOrphanedRuns,
 * handlePodDeath, and the reaper's terminal DB write) are tested against real
 * Postgres in run-registry.integration.test.ts.
 */
function inertDeps(): RunReactorDeps {
  const noop = async () => undefined as never;
  return {
    storage: {
      update: noop,
      create: noop,
      get: async () => null,
      delete: noop,
      list: async () => ({ threads: [], total: 0 }),
      saveMessages: noop,
      listMessages: async () => ({ messages: [], total: 0 }),
      listByTriggerIds: async () => ({ threads: [], total: 0 }),
      forceFailIfInProgress: async () => false,
      claimOrphanedRun: async () => false,
      claimRunStart: async () => true,
      listOrphanedRuns: async () => [],
      listOrphanedRunsByPod: async () => [],
      orphanRunsByPod: async () => [],
    } as unknown as RunReactorDeps["storage"],
    streamBuffer: { purge() {} } as unknown as StreamBuffer,
    sseHub: { emit() {} },
  };
}

const createdRegistries: RunRegistry[] = [];

afterEach(() => {
  for (const r of createdRegistries) r.dispose();
  createdRegistries.length = 0;
});

/** Create a registry and register it for reaper-timer cleanup. */
function createRegistry(clock?: () => Date): RunRegistry {
  const podId = "test-pod";
  const r = clock
    ? new RunRegistry(inertDeps(), podId, clock)
    : new RunRegistry(inertDeps(), podId);
  createdRegistries.push(r);
  return r;
}

/** Dispatch a START command for a given thread and return the transitions. */
function startThread(
  registry: RunRegistry,
  taskId: string,
  orgId = "org1",
  userId = "u1",
) {
  return registry.dispatch({
    type: "START",
    taskId,
    orgId,
    userId,
    abortController: new AbortController(),
  });
}

// ---------------------------------------------------------------------------
// Tests — pure in-memory state machine
// ---------------------------------------------------------------------------

describe("RunRegistry (in-memory state machine)", () => {
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

      const pairs = registry.dispatch({ type: "CANCEL", taskId: "t1" });

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

      registry.dispatch({ type: "CANCEL", taskId: "t1" });

      expect(signal.aborted).toBe(true);
    });

    it("returns empty array for a non-running thread", () => {
      const registry = createRegistry();
      const pairs = registry.dispatch({ type: "CANCEL", taskId: "t1" });
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
        taskId: "t1",
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
        taskId: "t1",
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
        taskId: "t1",
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
        taskId: "t1",
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
        taskId: "t1",
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
        taskId: "t1",
        reason: "reaped",
      });

      expect(signal.aborted).toBe(true);
    });

    it("emits RUN_FAILED with reason 'ghost' even when no in-memory state exists", () => {
      const registry = createRegistry();

      const pairs = registry.dispatch({
        type: "FORCE_FAIL",
        taskId: "t1",
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
        taskId: "t1",
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

      const pairs = registry.dispatch({ type: "STEP_DONE", taskId: "t1" });

      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.event.type).toBe("STEP_COMPLETED");
      if (pairs[0]!.event.type === "STEP_COMPLETED") {
        expect(pairs[0]!.event.stepCount).toBe(1);
      }
    });

    it("returns empty array when thread is not running", () => {
      const registry = createRegistry();
      const pairs = registry.dispatch({ type: "STEP_DONE", taskId: "t1" });
      expect(pairs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getAbortSignal
  // -------------------------------------------------------------------------
  describe("getAbortSignal", () => {
    it("returns null for an unknown taskId", () => {
      const registry = createRegistry();
      expect(registry.getAbortSignal("nope")).toBeNull();
    });

    it("returns null after a run finishes", () => {
      const registry = createRegistry();
      startThread(registry, "t1");

      registry.dispatch({
        type: "FINISH",
        taskId: "t1",
        threadStatus: "completed",
      });

      expect(registry.getAbortSignal("t1")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // reapStaleRuns — timing decision only (the terminal DB write it triggers is
  // covered against real Postgres in run-registry.integration.test.ts)
  // -------------------------------------------------------------------------
  describe("reapStaleRuns (timing)", () => {
    const MAX_RUN_AGE_MS = 30 * 60 * 1000;

    it("does not reap a run just under MAX_RUN_AGE_MS", () => {
      let now = new Date("2024-01-01T00:00:00Z");
      const registry = createRegistry(() => now);

      startThread(registry, "t1", "org1", "u1");

      // Advance time to just under the threshold
      now = new Date(now.getTime() + MAX_RUN_AGE_MS - 1);

      (registry as unknown as { reapStaleRuns(): void }).reapStaleRuns();

      expect(registry.isRunning("t1")).toBe(true);
    });

    it("reaps only stale runs when multiple threads are present", () => {
      let now = new Date("2024-01-01T00:00:00Z");
      const registry = createRegistry(() => now);

      startThread(registry, "old", "org1", "u1");

      // Advance clock, then start a fresh run
      now = new Date(now.getTime() + MAX_RUN_AGE_MS + 1);
      startThread(registry, "fresh", "org1", "u2");

      (registry as unknown as { reapStaleRuns(): void }).reapStaleRuns();

      expect(registry.isRunning("old")).toBe(false);
      expect(registry.isRunning("fresh")).toBe(true);
    });
  });
});
