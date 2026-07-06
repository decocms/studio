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
});
