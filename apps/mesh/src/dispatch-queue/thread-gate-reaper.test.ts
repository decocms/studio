import { describe, expect, it } from "bun:test";
import {
  reapOrphanedGatesSweep,
  type ThreadGateReaperRuntime,
} from "./thread-gate-reaper";

function fakeRuntime(
  overrides: Partial<ThreadGateReaperRuntime> = {},
): ThreadGateReaperRuntime {
  return {
    listStuckRuns: async () => [],
    forceFailIfInProgress: async () => false,
    listOrphanedGateWorkflows: async () => [],
    cancelGateWorkflow: async () => {},
    ...overrides,
  };
}

describe("reapOrphanedGatesSweep", () => {
  it("cancels each orphaned gate past the grace and returns the count", async () => {
    const cancelled: string[] = [];
    let cutoffSeen = -1;
    const rt = fakeRuntime({
      listOrphanedGateWorkflows: async (cutoffMs) => {
        cutoffSeen = cutoffMs;
        return ["thread-run:t1:m1", "thread-run:t2:m2"];
      },
      cancelGateWorkflow: async (id) => {
        cancelled.push(id);
      },
    });

    const reaped = await reapOrphanedGatesSweep(rt, 1_000_000, 60_000);

    // The sweep hands the storage a "dispatch completed before" cutoff of now - grace.
    expect(cutoffSeen).toBe(1_000_000 - 60_000);
    expect(cancelled).toEqual(["thread-run:t1:m1", "thread-run:t2:m2"]);
    expect(reaped).toBe(2);
  });

  it("no-ops when nothing is orphaned", async () => {
    let cancels = 0;
    const rt = fakeRuntime({
      listOrphanedGateWorkflows: async () => [],
      cancelGateWorkflow: async () => {
        cancels++;
      },
    });

    const reaped = await reapOrphanedGatesSweep(rt, 5_000_000, 60_000);

    expect(reaped).toBe(0);
    expect(cancels).toBe(0);
  });
});
