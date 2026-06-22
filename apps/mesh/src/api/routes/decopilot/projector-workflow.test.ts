import { describe, expect, test } from "bun:test";
import type { ProjectChunksResult } from "./project-chunks";
import {
  checkpointWorkflowId,
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
    // Checkpoint passes get a per-headSeq id so each incremental pass is a
    // distinct durable workflow (idempotent on replay of the same headSeq).
    expect(checkpointWorkflowId("run_1", "fence_a", 7)).toBe(
      "decopilot-checkpoint:run_1:fence_a:7",
    );
    // Single partitioned queue (partitioned by orgId at enqueue time), NOT a
    // per-org queue — mirrors AUTOMATIONS_QUEUE/THREAD_GATE_QUEUE.
    expect(PROJECTOR_QUEUE).toBe("decopilot-projector");
    expect(PROJECTOR_PARTITION_CONCURRENCY).toBe(10);
  });

  test("does not skip terminal runs for the same fence", () => {
    expect(
      shouldSkipProjection({
        status: "completed",
        runFenceToken: "fence_a",
        fenceToken: "fence_a",
      }),
    ).toBe(false);
    expect(
      shouldSkipProjection({
        status: "failed",
        runFenceToken: "fence_a",
        fenceToken: "fence_a",
      }),
    ).toBe(false);
  });

  test("skips terminal runs for a mismatched fence", () => {
    expect(
      shouldSkipProjection({
        status: "completed",
        runFenceToken: "newer",
        fenceToken: "fence_a",
      }),
    ).toBe(true);
    expect(
      shouldSkipProjection({
        status: "failed",
        runFenceToken: "newer",
        fenceToken: "fence_a",
      }),
    ).toBe(true);
  });

  test("skips superseded non-terminal runs", () => {
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
  kind: "complete" | "fail" | "record-complete" | "record-fail" | "purge";
  runId?: string;
  orgId?: string;
  distinctId?: string;
  reason?: string;
  failKind?: string;
  fenceToken?: string;
  usage?: ProjectChunksResult["usage"];
}

function makeRuntime(): { rt: ProjectorWorkflowRuntime; calls: FakeCall[] } {
  const calls: FakeCall[] = [];

  const rt: ProjectorWorkflowRuntime = {
    getJetStream: () => null as never,
    getJetStreamManager: async () => null as never,
    resolveRun: async (_runId) => ({
      orgId: "org_1",
      createdBy: "user_1",
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
    recordCompleted: async ({ runId, orgId, distinctId, usage }) => {
      calls.push({ kind: "record-complete", runId, orgId, distinctId, usage });
    },
    recordFailed: async ({ runId, orgId, distinctId, reason, kind }) => {
      calls.push({
        kind: "record-fail",
        runId,
        orgId,
        distinctId,
        reason,
        failKind: kind,
      });
    },
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
      outcome: {
        failed: true,
        finishReason: undefined,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
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
    const recordFailCall = calls.find((c) => c.kind === "record-fail");
    expect(recordFailCall?.failKind).toBe("harness");
    expect(recordFailCall?.reason).toBe(failCall.reason);
    expect(recordFailCall?.runId).toBe("run_1");
    expect(recordFailCall?.orgId).toBe("org_1");
    expect(recordFailCall?.distinctId).toBe("user_1");
  });

  test("harness-failed with finishReason → reason derived from finishReason", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({
      outcome: {
        failed: true,
        finishReason: "error",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    const failCall = calls.find((c) => c.kind === "fail");
    expect(failCall?.reason).toContain("error");
    expect(failCall?.failKind).toBe("harness");
  });

  test("clean outcome (failed=false) → completeRunIfNotCompleted called, markRunFailed NOT called", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({
      outcome: {
        failed: false,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    const completeCalls = calls.filter((c) => c.kind === "complete");
    const failCalls = calls.filter((c) => c.kind === "fail");

    expect(completeCalls).toHaveLength(1);
    expect(failCalls).toHaveLength(0);
    expect(calls.find((c) => c.kind === "record-complete")?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    expect(calls.find((c) => c.kind === "record-complete")?.distinctId).toBe(
      "user_1",
    );
    expect(calls.find((c) => c.kind === "record-complete")?.runId).toBe(
      "run_1",
    );
    expect(calls.find((c) => c.kind === "record-complete")?.orgId).toBe(
      "org_1",
    );
  });

  test("undefined outcome → completeRunIfNotCompleted called (treated as clean)", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({ outcome: undefined });

    await runProjectorWorkflowBody(input, rt, projectFn);

    const completeCalls = calls.filter((c) => c.kind === "complete");
    const failCalls = calls.filter((c) => c.kind === "fail");

    expect(completeCalls).toHaveLength(1);
    expect(failCalls).toHaveLength(0);
    expect(calls.find((c) => c.kind === "record-complete")?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
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
    const recordFailCall = calls.find((c) => c.kind === "record-fail");
    expect(recordFailCall?.failKind).toBe("projection");
    expect(recordFailCall?.reason).toBe(failCall.reason);
    expect(recordFailCall?.runId).toBe("run_1");
    expect(recordFailCall?.orgId).toBe("org_1");
    expect(recordFailCall?.distinctId).toBe("user_1");
  });

  test("purge (cleanup) runs on BOTH completed and harness-failed terminal paths", async () => {
    // completed path
    const { rt: rt1, calls: calls1 } = makeRuntime();
    await runProjectorWorkflowBody(
      input,
      rt1,
      makeProjectFn({
        outcome: {
          failed: false,
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      }),
    );
    expect(calls1.filter((c) => c.kind === "purge")).toHaveLength(1);

    // harness-failed path
    const { rt: rt2, calls: calls2 } = makeRuntime();
    await runProjectorWorkflowBody(
      input,
      rt2,
      makeProjectFn({
        outcome: {
          failed: true,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      }),
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
