import { describe, expect, test } from "bun:test";
import type { ThreadStoragePort } from "@/storage/ports";
import { reactAll, type RunReactorDeps } from "./run-reactor";

describe("run reactor", () => {
  test("RUN_FAILED writes the terminal status + emits SSE, and does NOT purge the stream", async () => {
    const updates: unknown[] = [];
    const emitted: unknown[] = [];
    const deps: RunReactorDeps = {
      storage: {
        update: async (_id: string, _orgId: string, data: unknown) => {
          updates.push(data);
          return null;
        },
        get: async () => ({
          id: "run_1",
          organization_id: "org_1",
          created_by: "user_1",
          status: "failed",
        }),
        forceFailIfInProgress: async () => true,
      } as unknown as ThreadStoragePort,
      sseHub: {
        emit: (_orgId, event) => {
          emitted.push(event);
        },
      },
    };

    await reactAll(
      [
        {
          event: {
            type: "RUN_FAILED",
            taskId: "run_1",
            orgId: "org_1",
            reason: "error",
          },
          // Post-projection RUN_FAILED carries no in-memory state (the run was
          // evicted); orgId rides on the event. See RunTransition.
          state: undefined,
        },
      ],
      deps,
    );

    expect(updates).toHaveLength(1);
    // Regression guard: the reactor must NOT purge the run's JetStream
    // subject on RUN_FAILED. The consume step still projects force-failed
    // runs and needs the contiguous seq 1..N log — a mid-run purge beheads
    // it and the projector poisons the thread with "missing seq N".
    // Structural since RunReactorDeps no longer accepts a stream buffer.
    expect(emitted).toHaveLength(2);
  });

  test("RUN_FAILED reason 'reaped' records a stall failure_reason/kind", async () => {
    const updates: Record<string, unknown>[] = [];
    const deps: RunReactorDeps = {
      storage: {
        update: async (
          _id: string,
          _orgId: string,
          data: Record<string, unknown>,
        ) => {
          updates.push(data);
          return null;
        },
        get: async () => ({
          id: "run_1",
          organization_id: "org_1",
          created_by: "user_1",
          status: "failed",
        }),
        forceFailIfInProgress: async () => true,
      } as unknown as ThreadStoragePort,
      sseHub: { emit: () => {} },
    };

    await reactAll(
      [
        {
          event: {
            type: "RUN_FAILED",
            taskId: "run_1",
            orgId: "org_1",
            reason: "reaped",
          },
          state: undefined,
        },
      ],
      deps,
    );

    expect(updates).toHaveLength(1);
    // The `failed` status itself comes from the `in_progress`-guarded
    // `forceFailIfInProgress`, NOT from this update — an unguarded status write
    // here stamped `failed` over runs the projector had already completed.
    expect(updates[0]!.status).toBeUndefined();
    expect(updates[0]!.failure_reason).toBe(
      "Run stalled — no progress within the idle timeout window",
    );
    expect(updates[0]!.failure_kind).toBe("stall");
  });

  // Inverted: this used to assert 'error' left both columns unset, on the
  // theory that its reason "is surfaced elsewhere". It was surfaced only as an
  // error PART, so every reader of the thread ROW — the board card, the task
  // list, a support query — saw `failed` with `failure_reason: ''` and
  // `failure_kind: null` and could not tell a crash from a cancel.
  test("RUN_FAILED reason 'error' records a legible reason and kind", async () => {
    const updates: Record<string, unknown>[] = [];
    const deps: RunReactorDeps = {
      storage: {
        update: async (
          _id: string,
          _orgId: string,
          data: Record<string, unknown>,
        ) => {
          updates.push(data);
          return null;
        },
        get: async () => ({
          id: "run_1",
          organization_id: "org_1",
          status: "failed",
        }),
        forceFailIfInProgress: async () => true,
      } as unknown as ThreadStoragePort,
      sseHub: { emit: () => {} },
    };

    await reactAll(
      [
        {
          event: {
            type: "RUN_FAILED",
            taskId: "run_1",
            orgId: "org_1",
            reason: "error",
          },
          state: undefined,
        },
      ],
      deps,
    );

    expect(updates[0]!.failure_reason).toBe(
      "Run ended with an error — see the run's messages",
    );
    expect(updates[0]!.failure_kind).toBe("error");
  });

  // The failure this investigation started from: a takeover / client hangup
  // surfaced as `cancelled: run cancelled` in an error part, while the thread
  // row carried no reason at all.
  test("RUN_FAILED reason 'cancelled' records a cancelled kind, not a bare write", async () => {
    const updates: Record<string, unknown>[] = [];
    const deps: RunReactorDeps = {
      storage: {
        update: async (
          _id: string,
          _orgId: string,
          data: Record<string, unknown>,
        ) => {
          updates.push(data);
          return null;
        },
        get: async () => ({
          id: "run_1",
          organization_id: "org_1",
          status: "failed",
        }),
        forceFailIfInProgress: async () => true,
      } as unknown as ThreadStoragePort,
      sseHub: { emit: () => {} },
    };

    await reactAll(
      [
        {
          event: {
            type: "RUN_FAILED",
            taskId: "run_1",
            orgId: "org_1",
            reason: "cancelled",
          },
          state: undefined,
        },
      ],
      deps,
    );

    expect(updates[0]!.failure_kind).toBe("cancelled");
    expect(updates[0]!.failure_reason).toBe("Run cancelled before it finished");
  });

  // `ghost` keeps its bare write: it force-fails a row whose run never existed
  // on this pod, and stamping a reason there would overwrite the real one a
  // concurrent terminal writer just set.
  test("RUN_FAILED reason 'ghost' still records no reason", async () => {
    const updates: Record<string, unknown>[] = [];
    const deps: RunReactorDeps = {
      storage: {
        update: async (
          _id: string,
          _orgId: string,
          data: Record<string, unknown>,
        ) => {
          updates.push(data);
          return null;
        },
        get: async () => ({
          id: "run_1",
          organization_id: "org_1",
          status: "failed",
        }),
        forceFailIfInProgress: async () => true,
      } as unknown as ThreadStoragePort,
      sseHub: { emit: () => {} },
    };

    await reactAll(
      [
        {
          event: {
            type: "RUN_FAILED",
            taskId: "run_1",
            orgId: "org_1",
            reason: "ghost",
          },
          state: undefined,
        },
      ],
      deps,
    );

    expect(updates[0]!.failure_reason).toBeUndefined();
    expect(updates[0]!.failure_kind).toBeUndefined();
  });

  // A late `RUN_FAILED` for a run the projector already settled must be a
  // no-op. Before the guard, this write had no `status` predicate and stamped
  // `failed` over a `completed` thread — and permanently, because every
  // projector transition is itself guarded on `in_progress`.
  test("RUN_FAILED does not overwrite an already-settled thread", async () => {
    const updates: Record<string, unknown>[] = [];
    let guardCalls = 0;
    const deps: RunReactorDeps = {
      storage: {
        update: async (
          _id: string,
          _orgId: string,
          data: Record<string, unknown>,
        ) => {
          updates.push(data);
          return null;
        },
        get: async () => ({
          id: "run_1",
          organization_id: "org_1",
          status: "completed",
        }),
        // What Postgres answers for a row that is no longer `in_progress`.
        forceFailIfInProgress: async () => {
          guardCalls++;
          return false;
        },
      } as unknown as ThreadStoragePort,
      sseHub: { emit: () => {} },
    };

    await reactAll(
      [
        {
          event: {
            type: "RUN_FAILED",
            taskId: "run_1",
            orgId: "org_1",
            reason: "error",
          },
          state: undefined,
        },
      ],
      deps,
    );

    expect(guardCalls).toBe(1);
    expect(updates).toEqual([]);
  });

  test("RUN_STARTED clears any stale failure_reason/failure_kind from a prior run", async () => {
    const updates: Record<string, unknown>[] = [];
    const deps: RunReactorDeps = {
      storage: {
        update: async (
          _id: string,
          _orgId: string,
          data: Record<string, unknown>,
        ) => {
          updates.push(data);
          return null;
        },
        get: async () => ({
          id: "run_1",
          organization_id: "org_1",
          created_by: "user_1",
          status: "in_progress",
        }),
      } as unknown as ThreadStoragePort,
      sseHub: { emit: () => {} },
    };

    await reactAll(
      [
        {
          event: {
            type: "RUN_STARTED",
            taskId: "run_1",
            orgId: "org_1",
            userId: "user_1",
            abortController: new AbortController(),
            podId: "pod_1",
          },
          state: undefined,
        },
      ],
      deps,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.status).toBe("in_progress");
    expect(updates[0]!.failure_reason).toBeNull();
    expect(updates[0]!.failure_kind).toBeNull();
  });

  test("RUN_RESUMED restores in_progress and clears the stale force-fail columns", async () => {
    // Regression: a run force-failed as ghost/reaped and then recovered used to
    // keep status:"failed" in the DB — RUN_RESUMED only stamped run_started_at,
    // so the thread only self-corrected at the next FINISH. It must flip the row
    // back to in_progress on resume.
    const updates: Record<string, unknown>[] = [];
    const deps: RunReactorDeps = {
      storage: {
        update: async (
          _id: string,
          _orgId: string,
          data: Record<string, unknown>,
        ) => {
          updates.push(data);
          return null;
        },
        get: async () => ({
          id: "run_1",
          organization_id: "org_1",
          created_by: "user_1",
          status: "in_progress",
        }),
      } as unknown as ThreadStoragePort,
      sseHub: { emit: () => {} },
    };

    await reactAll(
      [
        {
          event: {
            type: "RUN_RESUMED",
            taskId: "run_1",
            orgId: "org_1",
            userId: "user_1",
            abortController: new AbortController(),
            podId: "pod_1",
          },
          state: undefined,
        },
      ],
      deps,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.status).toBe("in_progress");
    expect(updates[0]!.failure_reason).toBeNull();
    expect(updates[0]!.failure_kind).toBeNull();
    expect(updates[0]!.last_progress_at).toBeNull();
    // Resume must NOT overwrite the prior run's config.
    expect(updates[0]!).not.toHaveProperty("run_config");
  });

  test("RUN_STARTED emits the in_progress thread-status event with data.message_id", async () => {
    const emitted: { type: string; data: Record<string, unknown> }[] = [];
    const deps: RunReactorDeps = {
      storage: {
        update: async () => null,
        get: async () => ({
          id: "run_1",
          organization_id: "org_1",
          created_by: "user_1",
          status: "in_progress",
        }),
      } as unknown as ThreadStoragePort,
      sseHub: {
        emit: (_orgId, event) => {
          emitted.push(
            event as { type: string; data: Record<string, unknown> },
          );
        },
      },
    };

    await reactAll(
      [
        {
          event: {
            type: "RUN_STARTED",
            taskId: "run_1",
            orgId: "org_1",
            userId: "user_1",
            abortController: new AbortController(),
            podId: "pod_1",
            messageId: "m1",
          },
          state: undefined,
        },
      ],
      deps,
    );

    const statusEvent = emitted.find(
      (event) => event.type === "decopilot.thread.status",
    );
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.data.message_id).toBe("m1");
  });

  // A force-failed run never reaches the projector, so this reactor is its
  // only terminal writer. Without the hook the task card stays parked In
  // Progress and its quota charge is never released — the customer pays for a
  // run that produced nothing.
  describe("thread-finish hook on a force-fail", () => {
    const depsWith = (
      transitions: boolean,
      finished: Array<[string, string]>,
      hook?: () => Promise<void>,
    ): RunReactorDeps => ({
      storage: {
        update: async () => null,
        get: async () => ({
          id: "run_1",
          organization_id: "org_1",
          created_by: "user_1",
          status: "failed",
        }),
        forceFailIfInProgress: async () => transitions,
      } as unknown as ThreadStoragePort,
      sseHub: { emit: () => {} },
      onThreadFinished: async (threadId, orgId) => {
        finished.push([threadId, orgId]);
        if (hook) await hook();
      },
    });

    const runFailed = (reason: "error" | "cancelled" | "reaped") => [
      {
        event: {
          type: "RUN_FAILED" as const,
          taskId: "run_1",
          orgId: "org_1",
          reason,
        },
        state: undefined,
      },
    ];

    for (const reason of ["error", "cancelled", "reaped"] as const) {
      test(`fires for reason '${reason}'`, async () => {
        const finished: Array<[string, string]> = [];
        await reactAll(runFailed(reason), depsWith(true, finished));
        expect(finished).toEqual([["run_1", "org_1"]]);
      });
    }

    test("does NOT fire when the force-fail was a no-op", async () => {
      // Another writer already settled this run — it owns the board pass, and
      // firing here could refund a claim its terminal deliberately kept.
      const finished: Array<[string, string]> = [];
      await reactAll(runFailed("error"), depsWith(false, finished));
      expect(finished).toEqual([]);
    });

    test("a throwing hook never breaks the reactor", async () => {
      const finished: Array<[string, string]> = [];
      const deps = depsWith(true, finished, () => {
        throw new Error("board unavailable");
      });
      await expect(reactAll(runFailed("error"), deps)).resolves.toBeUndefined();
      expect(finished).toEqual([["run_1", "org_1"]]);
    });
  });
});
