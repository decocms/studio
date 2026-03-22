import { afterEach, describe, expect, it, mock } from "bun:test";
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
      listByTriggerIds: mock(() => Promise.resolve({ threads: [], total: 0 })),
      forceFailIfInProgress: mock(() => Promise.resolve(false)),
      claimOrphanedRun: mock(() => Promise.resolve(false)),
      listOrphanedRuns: mock(() => Promise.resolve([])),
      orphanRunsByPod: mock(() => Promise.resolve([])),
    },
    streamBuffer: { purge: mock(() => {}) } as unknown as StreamBuffer,
    sseHub: { emit: mock(() => {}) },
  };
}

const createdRegistries: RunRegistry[] = [];

afterEach(() => {
  for (const r of createdRegistries) r.dispose();
  createdRegistries.length = 0;
});

/** Create a registry backed by no-op mocks and register it for cleanup. */
function createRegistry(
  deps = makeNoopDeps(),
  clock?: () => Date,
): RunRegistry {
  const podId = "test-pod";
  const r = clock
    ? new RunRegistry(deps, podId, clock)
    : new RunRegistry(deps, podId);
  createdRegistries.push(r);
  return r;
}

/** Dispatch a START command for a given thread and return the transitions. */
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

/** Flush all immediately-resolved promise microtasks. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  describe("stopAll (orphan semantics)", () => {
    it("orphans runs in DB, aborts running entries, and clears state", async () => {
      const deps = makeNoopDeps();
      const registry = createRegistry(deps);

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

      await registry.stopAll();

      // DB orphan is called first so runs are resumable if process dies
      expect(deps.storage.orphanRunsByPod).toHaveBeenCalled();

      // In-memory: abort controllers triggered and state cleared
      expect(signalT1.aborted).toBe(true);
      expect(signalT2.aborted).toBe(true);
      expect(registry.isRunning("t1")).toBe(false);
      expect(registry.isRunning("t2")).toBe(false);
    });

    it("calls orphanRunsByPod with correct podId", async () => {
      const deps = makeNoopDeps();
      const registry = createRegistry(deps);
      startThread(registry, "t1", "org1", "u1");

      await registry.stopAll();
      expect(deps.storage.orphanRunsByPod).toHaveBeenCalledWith("test-pod");
    });

    it("aborts AbortControllers", async () => {
      const deps = makeNoopDeps();
      const registry = createRegistry(deps);
      startThread(registry, "t1", "org1", "u1");
      const signal = registry.getAbortSignal("t1")!;

      await registry.stopAll();
      expect(signal.aborted).toBe(true);
    });

    it("clears in-memory state", async () => {
      const deps = makeNoopDeps();
      const registry = createRegistry(deps);
      startThread(registry, "t1", "org1", "u1");

      await registry.stopAll();
      expect(registry.isRunning("t1")).toBe(false);
    });

    it("handles orphanRunsByPod failure gracefully", async () => {
      const deps = makeNoopDeps();
      (
        deps.storage.orphanRunsByPod as ReturnType<typeof mock>
      ).mockImplementation(() => Promise.reject(new Error("DB down")));
      const registry = createRegistry(deps);
      startThread(registry, "t1", "org1", "u1");
      const signal = registry.getAbortSignal("t1")!;

      await registry.stopAll(); // should not throw

      // controllers still aborted, state still cleared
      expect(signal.aborted).toBe(true);
      expect(registry.isRunning("t1")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // recoverOrphanedRuns
  // -------------------------------------------------------------------------
  describe("recoverOrphanedRuns", () => {
    it("auto-resumes automation runs (trigger_id set)", async () => {
      const deps = makeNoopDeps();
      (
        deps.storage.listOrphanedRuns as ReturnType<typeof mock>
      ).mockImplementation(() =>
        Promise.resolve([
          {
            id: "t1",
            organization_id: "org1",
            trigger_id: "trig1",
            run_config: {},
            title: "t",
            description: null,
            status: "in_progress",
            created_at: "",
            updated_at: "",
            created_by: "u1",
            updated_by: null,
            hidden: false,
            context_start_message_id: null,
            run_owner_pod: null,
            run_started_at: null,
          },
        ]),
      );
      (
        deps.storage.claimOrphanedRun as ReturnType<typeof mock>
      ).mockImplementation(() => Promise.resolve(true));
      const registry = createRegistry(deps);
      const resumeFn = mock(() => Promise.resolve());
      await registry.recoverOrphanedRuns(resumeFn);
      expect(resumeFn).toHaveBeenCalled();
    });

    it("skips interactive runs (trigger_id null)", async () => {
      const deps = makeNoopDeps();
      (
        deps.storage.listOrphanedRuns as ReturnType<typeof mock>
      ).mockImplementation(() =>
        Promise.resolve([
          {
            id: "t1",
            organization_id: "org1",
            trigger_id: null,
            run_config: {},
            title: "t",
            description: null,
            status: "in_progress",
            created_at: "",
            updated_at: "",
            created_by: "u1",
            updated_by: null,
            hidden: false,
            context_start_message_id: null,
            run_owner_pod: null,
            run_started_at: null,
          },
        ]),
      );
      const registry = createRegistry(deps);
      const resumeFn = mock(() => Promise.resolve());
      await registry.recoverOrphanedRuns(resumeFn);
      expect(resumeFn).not.toHaveBeenCalled();
    });

    it("skips when CAS claim fails", async () => {
      const deps = makeNoopDeps();
      (
        deps.storage.listOrphanedRuns as ReturnType<typeof mock>
      ).mockImplementation(() =>
        Promise.resolve([
          {
            id: "t1",
            organization_id: "org1",
            trigger_id: "trig1",
            run_config: {},
            title: "t",
            description: null,
            status: "in_progress",
            created_at: "",
            updated_at: "",
            created_by: "u1",
            updated_by: null,
            hidden: false,
            context_start_message_id: null,
            run_owner_pod: null,
            run_started_at: null,
          },
        ]),
      );
      (
        deps.storage.claimOrphanedRun as ReturnType<typeof mock>
      ).mockImplementation(() => Promise.resolve(false));
      const registry = createRegistry(deps);
      const resumeFn = mock(() => Promise.resolve());
      await registry.recoverOrphanedRuns(resumeFn);
      expect(resumeFn).not.toHaveBeenCalled();
    });

    it("force-fails on resumeFn error", async () => {
      const deps = makeNoopDeps();
      (
        deps.storage.listOrphanedRuns as ReturnType<typeof mock>
      ).mockImplementation(() =>
        Promise.resolve([
          {
            id: "t1",
            organization_id: "org1",
            trigger_id: "trig1",
            run_config: {},
            title: "t",
            description: null,
            status: "in_progress",
            created_at: "",
            updated_at: "",
            created_by: "u1",
            updated_by: null,
            hidden: false,
            context_start_message_id: null,
            run_owner_pod: null,
            run_started_at: null,
          },
        ]),
      );
      (
        deps.storage.claimOrphanedRun as ReturnType<typeof mock>
      ).mockImplementation(() => Promise.resolve(true));
      const registry = createRegistry(deps);
      const resumeFn = mock(() => Promise.reject(new Error("boom")));
      await registry.recoverOrphanedRuns(resumeFn);
      expect(deps.storage.forceFailIfInProgress).toHaveBeenCalledWith(
        "t1",
        "org1",
      );
    });

    it("handles empty orphan list", async () => {
      const deps = makeNoopDeps();
      (
        deps.storage.listOrphanedRuns as ReturnType<typeof mock>
      ).mockImplementation(() => Promise.resolve([]));
      const registry = createRegistry(deps);
      const resumeFn = mock(() => Promise.resolve());
      await registry.recoverOrphanedRuns(resumeFn);
      expect(resumeFn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // reapStaleRuns
  // -------------------------------------------------------------------------
  describe("reapStaleRuns", () => {
    const MAX_RUN_AGE_MS = 30 * 60 * 1000;

    it("reaps a run past MAX_RUN_AGE_MS and triggers reactor side-effects", async () => {
      const deps = makeNoopDeps();
      let now = new Date("2024-01-01T00:00:00Z");
      const registry = createRegistry(deps, () => now);

      startThread(registry, "t1", "org1", "u1");
      const signal = registry.getAbortSignal("t1")!;

      // Advance time past the threshold
      now = new Date(now.getTime() + MAX_RUN_AGE_MS + 1);

      (registry as any).reapStaleRuns();

      expect(signal.aborted).toBe(true);
      expect(registry.isRunning("t1")).toBe(false);

      await flushMicrotasks();

      expect(deps.storage.update).toHaveBeenCalledWith("t1", "org1", {
        status: "failed",
        run_owner_pod: null,
        run_config: null,
        run_started_at: null,
      });
      expect(deps.streamBuffer.purge).toHaveBeenCalledWith("t1");
    });

    it("does not reap a run just under MAX_RUN_AGE_MS", () => {
      const deps = makeNoopDeps();
      let now = new Date("2024-01-01T00:00:00Z");
      const registry = createRegistry(deps, () => now);

      startThread(registry, "t1", "org1", "u1");

      // Advance time to just under the threshold
      now = new Date(now.getTime() + MAX_RUN_AGE_MS - 1);

      (registry as any).reapStaleRuns();

      expect(registry.isRunning("t1")).toBe(true);
      expect(deps.storage.update).not.toHaveBeenCalled();
    });

    it("reaps only stale runs when multiple threads are present", async () => {
      const deps = makeNoopDeps();
      let now = new Date("2024-01-01T00:00:00Z");
      const registry = createRegistry(deps, () => now);

      startThread(registry, "old", "org1", "u1");

      // Advance clock, then start a fresh run
      now = new Date(now.getTime() + MAX_RUN_AGE_MS + 1);
      startThread(registry, "fresh", "org1", "u2");

      (registry as any).reapStaleRuns();

      expect(registry.isRunning("old")).toBe(false);
      expect(registry.isRunning("fresh")).toBe(true);
    });
  });
});
