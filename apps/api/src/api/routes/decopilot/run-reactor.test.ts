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
    expect(updates[0]!.status).toBe("failed");
    expect(updates[0]!.failure_reason).toBe(
      "Run stalled — no progress within the idle timeout window",
    );
    expect(updates[0]!.failure_kind).toBe("stall");
  });

  test("RUN_FAILED reason 'error' does NOT set failure_reason (unchanged)", async () => {
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

    expect(updates[0]!.failure_reason).toBeUndefined();
    expect(updates[0]!.failure_kind).toBeUndefined();
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
          routing_locked_at: "2026-08-04T12:00:00.000Z",
          hosted_execution_disabled_at: null,
          harness_id: "decopilot",
          sandbox_provider_kind: "agent-sandbox",
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
    expect(statusEvent!.data.routing_locked_at).toBe(
      "2026-08-04T12:00:00.000Z",
    );
    expect(statusEvent!.data.hosted_execution_disabled_at).toBeNull();
    expect(statusEvent!.data.harness_id).toBe("decopilot");
    expect(statusEvent!.data.sandbox_provider_kind).toBe("agent-sandbox");
  });
});
