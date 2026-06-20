import { describe, expect, test } from "bun:test";
import type { ProjectChunksResult } from "./project-chunks";
import {
  PROJECTOR_PARTITION_CONCURRENCY,
  PROJECTOR_QUEUE,
  projectorWorkflowId,
  runProjectorWorkflowBody,
  shouldSkipProjection,
} from "./projector-workflow";
import type { ProjectorWorkflowRuntime } from "./projector-workflow";

describe("projector workflow helpers", () => {
  test("builds deterministic workflow ids on a single partitioned queue", () => {
    expect(projectorWorkflowId("run_1", "fence_a")).toBe(
      "decopilot-project:run_1:fence_a",
    );
    // Single partitioned queue (partitioned by orgId at enqueue time), NOT a
    // per-org queue — mirrors AUTOMATIONS_QUEUE/THREAD_GATE_QUEUE.
    expect(PROJECTOR_QUEUE).toBe("decopilot-projector");
    expect(PROJECTOR_PARTITION_CONCURRENCY).toBe(10);
  });

  test("skips terminal and superseded runs", () => {
    expect(
      shouldSkipProjection({
        status: "completed",
        runFenceToken: "fence_a",
        fenceToken: "fence_a",
      }),
    ).toBe(true);
    expect(
      shouldSkipProjection({
        status: "in_progress",
        runFenceToken: "newer",
        fenceToken: "fence_a",
      }),
    ).toBe(true);
    expect(
      shouldSkipProjection({
        status: "in_progress",
        runFenceToken: "fence_a",
        fenceToken: "fence_a",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runProjectorWorkflowBody tests — injected-runtime-fake style
// ---------------------------------------------------------------------------

interface FakeCall {
  kind: "complete" | "fail" | "purge";
  runId?: string;
  orgId?: string;
  reason?: string;
  failKind?: string;
  fenceToken?: string;
}

function makeRuntime(): { rt: ProjectorWorkflowRuntime; calls: FakeCall[] } {
  const calls: FakeCall[] = [];

  const rt: ProjectorWorkflowRuntime = {
    getJetStream: () => null as never,
    getJetStreamManager: async () => null as never,
    resolveRun: async (_runId) => ({
      orgId: "org_1",
      version: 2,
      status: "in_progress",
      runFenceToken: "fence_a",
      title: null,
    }),
    messageParts: null as never,
    completeRunIfNotCompleted: async (runId, orgId) => {
      calls.push({ kind: "complete", runId, orgId });
    },
    markRunFailed: async (runId, orgId, reason, kind) => {
      calls.push({ kind: "fail", runId, orgId, reason, failKind: kind });
    },
    persistTitle: async () => {},
    purgeRun: async (runId, fenceToken) => {
      calls.push({ kind: "purge", runId, fenceToken });
    },
    advanceProjectedSeq: async () => 0,
  };

  return { rt, calls };
}

/**
 * Builds the projectFromJetStream stub that will be injected into
 * runProjectorWorkflowBody. Instead of touching JetStream/NATS, it
 * immediately returns the provided outcome (or throws).
 */
function makeProjectFn(opts: {
  outcome?: ProjectChunksResult;
  throws?: string;
}): () => Promise<{
  chunkCount: number;
  attempts: number;
  outcome?: ProjectChunksResult;
}> {
  return async () => {
    if (opts.throws) throw new Error(opts.throws);
    return { chunkCount: 5, attempts: 1, outcome: opts.outcome };
  };
}

describe("runProjectorWorkflowBody", () => {
  const input = { runId: "run_1", fenceToken: "fence_a", finalSeq: 10 };

  test("harness-failed outcome → markRunFailed(kind='harness'), NOT completeRunIfNotCompleted", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({
      outcome: { failed: true, finishReason: undefined },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    const failCalls = calls.filter((c) => c.kind === "fail");
    const completeCalls = calls.filter((c) => c.kind === "complete");

    expect(completeCalls).toHaveLength(0);
    expect(failCalls).toHaveLength(1);
    const failCall = failCalls[0]!;
    expect(failCall.failKind).toBe("harness");
    expect(failCall.reason).toBeTruthy();
    expect(failCall.runId).toBe("run_1");
    expect(failCall.orgId).toBe("org_1");
  });

  test("harness-failed with finishReason → reason derived from finishReason", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({
      outcome: { failed: true, finishReason: "error" },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    const failCall = calls.find((c) => c.kind === "fail");
    expect(failCall?.reason).toContain("error");
    expect(failCall?.failKind).toBe("harness");
  });

  test("clean outcome (failed=false) → completeRunIfNotCompleted called, markRunFailed NOT called", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({
      outcome: { failed: false, finishReason: "stop" },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    const completeCalls = calls.filter((c) => c.kind === "complete");
    const failCalls = calls.filter((c) => c.kind === "fail");

    expect(completeCalls).toHaveLength(1);
    expect(failCalls).toHaveLength(0);
  });

  test("undefined outcome → completeRunIfNotCompleted called (treated as clean)", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({ outcome: undefined });

    await runProjectorWorkflowBody(input, rt, projectFn);

    const completeCalls = calls.filter((c) => c.kind === "complete");
    const failCalls = calls.filter((c) => c.kind === "fail");

    expect(completeCalls).toHaveLength(1);
    expect(failCalls).toHaveLength(0);
  });

  test("projection throw → markRunFailed(kind='projection') and workflow re-throws", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({ throws: "projection error boom" });

    await expect(
      runProjectorWorkflowBody(input, rt, projectFn),
    ).rejects.toThrow("projection error boom");

    const failCalls = calls.filter((c) => c.kind === "fail");
    const completeCalls = calls.filter((c) => c.kind === "complete");

    expect(completeCalls).toHaveLength(0);
    expect(failCalls).toHaveLength(1);
    const failCall = failCalls[0]!;
    expect(failCall.failKind).toBe("projection");
    expect(failCall.reason).toBeTruthy();
  });

  test("purge (cleanup) runs on BOTH completed and harness-failed terminal paths", async () => {
    // completed path
    const { rt: rt1, calls: calls1 } = makeRuntime();
    await runProjectorWorkflowBody(
      input,
      rt1,
      makeProjectFn({ outcome: { failed: false, finishReason: "stop" } }),
    );
    expect(calls1.filter((c) => c.kind === "purge")).toHaveLength(1);

    // harness-failed path
    const { rt: rt2, calls: calls2 } = makeRuntime();
    await runProjectorWorkflowBody(
      input,
      rt2,
      makeProjectFn({ outcome: { failed: true } }),
    );
    expect(calls2.filter((c) => c.kind === "purge")).toHaveLength(1);
  });

  test("purge does NOT run on projection-throw path (catch branch re-throws)", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({ throws: "poison" });

    await expect(
      runProjectorWorkflowBody(input, rt, projectFn),
    ).rejects.toThrow("poison");

    const purgeCalls = calls.filter((c) => c.kind === "purge");
    expect(purgeCalls).toHaveLength(0);
  });
});
