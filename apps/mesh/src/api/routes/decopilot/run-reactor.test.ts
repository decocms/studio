import { describe, it, expect, mock } from "bun:test";
import { reactAll } from "./run-reactor";
import type { RunReactorDeps } from "./run-reactor";
import type { RunTransition } from "./run-state";
import type { StreamBuffer } from "./stream-buffer";

// ============================================================================
// Helpers
// ============================================================================

function makeDeps(): RunReactorDeps {
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
      forceFailIfInProgress: mock(() => Promise.resolve(true)),
      claimOrphanedRun: mock(() => Promise.resolve(false)),
      listOrphanedRuns: mock(() => Promise.resolve([])),
      orphanRunsByPod: mock(() => Promise.resolve([])),
    },
    streamBuffer: { purge: mock(() => {}) } as unknown as StreamBuffer,
    sseHub: { emit: mock(() => {}) },
  };
}

function makeRunningState(threadId = "t1", orgId = "org1") {
  return {
    threadId,
    orgId,
    userId: "u1",
    status: {
      tag: "running" as const,
      abortController: new AbortController(),
      stepCount: 2,
      startedAt: new Date(),
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("reactAll", () => {
  describe("RUN_STARTED", () => {
    it("calls storage.update with in_progress and emits 1 SSE event", async () => {
      const deps = makeDeps();
      const pairs: RunTransition[] = [
        {
          event: {
            type: "RUN_STARTED",
            threadId: "t1",
            orgId: "org1",
            userId: "u1",
            abortController: new AbortController(),
          },
          state: makeRunningState(),
        },
      ];

      await reactAll(pairs, deps);

      expect(deps.storage.update).toHaveBeenCalledTimes(1);
      expect(deps.storage.update).toHaveBeenCalledWith("t1", "org1", {
        status: "in_progress",
        run_owner_pod: null,
        run_config: null,
        run_started_at: null,
      });
      expect(deps.sseHub.emit).toHaveBeenCalledTimes(1);
      expect(deps.streamBuffer.purge).not.toHaveBeenCalled();
    });
  });

  describe("RUN_RESUMED", () => {
    it("updates run_owner_pod and run_started_at, does NOT write status", async () => {
      const deps = makeDeps();
      await reactAll(
        [
          {
            event: {
              type: "RUN_RESUMED",
              threadId: "t1",
              orgId: "org1",
              userId: "u1",
              abortController: new AbortController(),
              podId: "pod-1",
            },
            state: makeRunningState(),
          },
        ],
        deps,
      );
      const call = (deps.storage.update as ReturnType<typeof mock>).mock
        .calls[0]!;
      const payload = call[2] as Record<string, unknown>;
      expect(payload).toMatchObject({
        run_owner_pod: "pod-1",
        run_started_at: expect.any(String),
      });
      expect(payload.status).toBeUndefined();
    });

    it("emits SSE in_progress event", async () => {
      const deps = makeDeps();
      await reactAll(
        [
          {
            event: {
              type: "RUN_RESUMED",
              threadId: "t1",
              orgId: "org1",
              userId: "u1",
              abortController: new AbortController(),
              podId: "pod-1",
            },
            state: makeRunningState(),
          },
        ],
        deps,
      );
      expect(deps.sseHub.emit).toHaveBeenCalled();
    });

    it("does NOT purge stream buffer", async () => {
      const deps = makeDeps();
      await reactAll(
        [
          {
            event: {
              type: "RUN_RESUMED",
              threadId: "t1",
              orgId: "org1",
              userId: "u1",
              abortController: new AbortController(),
              podId: "pod-1",
            },
            state: makeRunningState(),
          },
        ],
        deps,
      );
      expect(deps.streamBuffer.purge).not.toHaveBeenCalled();
    });
  });

  describe("STEP_COMPLETED", () => {
    it("emits 1 SSE step event using orgId from the event", async () => {
      const deps = makeDeps();
      const pairs: RunTransition[] = [
        {
          event: {
            type: "STEP_COMPLETED",
            threadId: "t1",
            orgId: "org1",
            stepCount: 3,
          },
          state: makeRunningState("t1", "org1"),
        },
      ];

      await reactAll(pairs, deps);

      expect(deps.storage.update).not.toHaveBeenCalled();
      expect(deps.sseHub.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe("RUN_COMPLETED", () => {
    it("calls storage.update(completed), purges buffer, emits 2 SSE events", async () => {
      const deps = makeDeps();
      const pairs: RunTransition[] = [
        {
          event: {
            type: "RUN_COMPLETED",
            threadId: "t1",
            orgId: "org1",
            stepCount: 5,
          },
          state: undefined, // evicted by projector
        },
      ];

      await reactAll(pairs, deps);

      expect(deps.storage.update).toHaveBeenCalledTimes(1);
      expect(deps.storage.update).toHaveBeenCalledWith("t1", "org1", {
        status: "completed",
        run_owner_pod: null,
        run_config: null,
        run_started_at: null,
      });
      expect(deps.streamBuffer.purge).toHaveBeenCalledTimes(1);
      expect(deps.streamBuffer.purge).toHaveBeenCalledWith("t1");
      expect(deps.sseHub.emit).toHaveBeenCalledTimes(2);
    });
  });

  describe("RUN_REQUIRES_ACTION", () => {
    it("calls storage.update(requires_action), purges buffer, emits 2 SSE events", async () => {
      const deps = makeDeps();
      const pairs: RunTransition[] = [
        {
          event: {
            type: "RUN_REQUIRES_ACTION",
            threadId: "t1",
            orgId: "org1",
            stepCount: 4,
          },
          state: undefined, // evicted by projector
        },
      ];

      await reactAll(pairs, deps);

      expect(deps.storage.update).toHaveBeenCalledTimes(1);
      expect(deps.storage.update).toHaveBeenCalledWith("t1", "org1", {
        status: "requires_action",
        run_owner_pod: null,
        run_config: null,
        run_started_at: null,
      });
      expect(deps.streamBuffer.purge).toHaveBeenCalledTimes(1);
      expect(deps.sseHub.emit).toHaveBeenCalledTimes(2);
    });
  });

  describe("RUN_FAILED", () => {
    it("error/cancelled/reaped reasons: calls storage.update(failed), purges buffer, emits 2 SSE events", async () => {
      for (const reason of ["error", "cancelled", "reaped"] as const) {
        const deps = makeDeps();
        const pairs: RunTransition[] = [
          {
            event: {
              type: "RUN_FAILED",
              threadId: "t1",
              orgId: "org1",
              reason,
            },
            state: undefined,
          },
        ];

        await reactAll(pairs, deps);

        expect(deps.storage.update).toHaveBeenCalledWith("t1", "org1", {
          status: "failed",
          run_owner_pod: null,
          run_config: null,
          run_started_at: null,
        });
        expect(deps.storage.forceFailIfInProgress).not.toHaveBeenCalled();
        expect(deps.streamBuffer.purge).toHaveBeenCalledWith("t1");
        expect(deps.sseHub.emit).toHaveBeenCalledTimes(2);
      }
    });

    it("ghost reason: calls forceFailIfInProgress instead of storage.update", async () => {
      const deps = makeDeps();
      const pairs: RunTransition[] = [
        {
          event: {
            type: "RUN_FAILED",
            threadId: "t1",
            orgId: "org1",
            reason: "ghost",
          },
          state: undefined,
        },
      ];

      await reactAll(pairs, deps);

      expect(deps.storage.forceFailIfInProgress).toHaveBeenCalledTimes(1);
      expect(deps.storage.forceFailIfInProgress).toHaveBeenCalledWith(
        "t1",
        "org1",
      );
      // After forceFailIfInProgress, run columns are cleared via update
      expect(deps.storage.update).toHaveBeenCalledWith("t1", "org1", {
        run_owner_pod: null,
        run_config: null,
        run_started_at: null,
      });
      expect(deps.streamBuffer.purge).toHaveBeenCalledWith("t1");
      expect(deps.sseHub.emit).toHaveBeenCalledTimes(2);
    });

    it("ghost reason: no SSE events emitted when forceFailIfInProgress returns false", async () => {
      const deps = makeDeps();
      (
        deps.storage.forceFailIfInProgress as ReturnType<typeof mock>
      ).mockImplementationOnce(() => Promise.resolve(false));

      const pairs: RunTransition[] = [
        {
          event: {
            type: "RUN_FAILED",
            threadId: "t1",
            orgId: "org1",
            reason: "ghost",
          },
          state: undefined,
        },
      ];

      await reactAll(pairs, deps);

      expect(deps.storage.forceFailIfInProgress).toHaveBeenCalledTimes(1);
      expect(deps.storage.update).not.toHaveBeenCalled();
      expect(deps.streamBuffer.purge).not.toHaveBeenCalled();
      expect(deps.sseHub.emit).not.toHaveBeenCalled();
    });
  });

  describe("PREVIOUS_RUN_ABORTED", () => {
    it("is a no-op — no storage, buffer, or SSE side effects", async () => {
      const deps = makeDeps();
      const pairs: RunTransition[] = [
        {
          event: {
            type: "PREVIOUS_RUN_ABORTED",
            threadId: "t1",
            orgId: "org1",
          },
          state: undefined,
        },
      ];

      await reactAll(pairs, deps);

      expect(deps.storage.update).not.toHaveBeenCalled();
      expect(deps.storage.forceFailIfInProgress).not.toHaveBeenCalled();
      expect(deps.streamBuffer.purge).not.toHaveBeenCalled();
      expect(deps.sseHub.emit).not.toHaveBeenCalled();
    });
  });

  describe("reactAll error propagation", () => {
    it("stops on first thrown error and does not process subsequent events", async () => {
      const deps = makeDeps();
      // Make the first storage.update throw
      (deps.storage.update as ReturnType<typeof mock>).mockImplementationOnce(
        () => Promise.reject(new Error("DB error")),
      );

      const pairs: RunTransition[] = [
        {
          event: {
            type: "RUN_STARTED",
            threadId: "t1",
            orgId: "org1",
            userId: "u1",
            abortController: new AbortController(),
          },
          state: makeRunningState(),
        },
        {
          event: {
            type: "RUN_COMPLETED",
            threadId: "t1",
            orgId: "org1",
            stepCount: 1,
          },
          state: undefined,
        },
      ];

      await expect(reactAll(pairs, deps)).rejects.toThrow("DB error");

      // Only the first event was processed — RUN_COMPLETED would call
      // storage.update a second time and emit 2 SSE events if it ran.
      expect(deps.storage.update).toHaveBeenCalledTimes(1);
      expect(deps.sseHub.emit).not.toHaveBeenCalled();
    });
  });
});
