import { describe, expect, test } from "bun:test";
import type { ThreadStoragePort } from "@/storage/ports";
import { reactAll, type RunReactorDeps } from "./run-reactor";
import type { StreamBuffer } from "./stream-buffer";

describe("run reactor", () => {
  test("RUN_FAILED purges the abandoned run's stream buffer", async () => {
    const purged: string[] = [];
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
      streamBuffer: {
        purge: (runId: string) => {
          purged.push(runId);
        },
      } as unknown as StreamBuffer,
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
    // Failed runs are NOT projected, so the durable projector never runs its
    // cleanup step for them — the reactor purges the abandoned stream buffer
    // here as explicit cleanup (see run-reactor.ts RUN_FAILED handling).
    expect(purged).toEqual(["run_1"]);
    expect(emitted).toHaveLength(2);
  });
});
