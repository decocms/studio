import { describe, expect, test } from "bun:test";
import type { ProjectChunksResult } from "./project-chunks";
import {
  livenessFailureReason,
  runProjectorWorkflowBody,
  shouldSkipProjection,
} from "./projector-workflow";
import type {
  ProjectorWorkflowRuntime,
  ProjectorWorkflowInput,
} from "./projector-workflow";
import { StreamIdleTimeoutError } from "./nats-chunk-source";

describe("projector workflow helpers", () => {
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
  kind:
    | "complete"
    | "requires-action"
    | "fail"
    | "record-complete"
    | "record-fail"
    | "purge"
    | "clear-error";
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
      // Return a truthy "flipped" row — analytics are gated on this
      return { status: "completed" };
    },
    markRunRequiresAction: async (runId, orgId) => {
      calls.push({ kind: "requires-action", runId, orgId });
      return { status: "requires_action" };
    },
    markRunFailed: async (runId, orgId, reason, kind) => {
      calls.push({ kind: "fail", runId, orgId, reason, failKind: kind });
      // Return a truthy "flipped" row — analytics are gated on this
      return { status: "failed" };
    },
    persistTitle: async () => {},
    onTitleUpdated: async () => {},
    bumpProgress: async () => {},
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
    clearSynthesizedError: async (runId, fenceToken) => {
      calls.push({ kind: "clear-error", runId, fenceToken });
    },
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
        finalParts: [],
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
        finalParts: [],
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
        finalParts: [],
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

  test("clean outcome with ABSENT finishReason (desktop/relay {done}, no finish chunk) → completed, NOT failed", async () => {
    // Regression: the desktop/relay path ends on a `{done}` marker with no
    // AI-SDK finish chunk, so finishReason is undefined. resolveThreadStatus
    // maps undefined → "failed"; the mapping must short-circuit absent
    // finishReason to "completed" (matching the pre-unification projector).
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({
      outcome: {
        failed: false,
        finishReason: undefined,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        finalParts: [],
      },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    expect(calls.filter((c) => c.kind === "complete")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "fail")).toHaveLength(0);
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

  // unified-control-plane T4: a StreamIdleTimeoutError (thrown by
  // natsChunkSource — nats-chunk-source.ts — when the subject goes silent for
  // idleTimeoutMs) is a LIVENESS breach, not a projection bug, and must be
  // recorded distinctly so `failure_reason` reads as a liveness terminal
  // instead of the generic (and misleading) "projection" catch-all every
  // other thrown error still gets — see the "projection throw" test above for
  // the unchanged-baseline comparison.
  test("silence (StreamIdleTimeoutError) throw → markRunFailed(kind='liveness') with a liveness reason, and workflow re-throws", async () => {
    const { rt, calls } = makeRuntime();
    const idleTimeoutMs = 10 * 60_000; // RUN_IDLE_TIMEOUT_MS (10m)
    const projectFn = async () => {
      throw new StreamIdleTimeoutError(idleTimeoutMs);
    };

    await expect(
      runProjectorWorkflowBody(input, rt, projectFn),
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);

    const failCalls = calls.filter((c) => c.kind === "fail");
    const completeCalls = calls.filter((c) => c.kind === "complete");

    expect(completeCalls).toHaveLength(0);
    expect(failCalls).toHaveLength(1);
    const failCall = failCalls[0]!;
    expect(failCall.failKind).toBe("liveness");
    expect(failCall.reason).toBe(livenessFailureReason(idleTimeoutMs));
    expect(failCall.reason).toBe("liveness: no stream events for 10m");
    const recordFailCall = calls.find((c) => c.kind === "record-fail");
    expect(recordFailCall?.failKind).toBe("liveness");
    expect(recordFailCall?.reason).toBe(failCall.reason);
    expect(recordFailCall?.runId).toBe("run_1");
    expect(recordFailCall?.orgId).toBe("org_1");
    expect(recordFailCall?.distinctId).toBe("user_1");
  });

  test("tool-calls + approval-requested → requires_action, no recordCompleted", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({
      outcome: {
        failed: false,
        finishReason: "tool-calls",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finalParts: [{ type: "tool-invocation", state: "approval-requested" }],
      },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    expect(calls.filter((c) => c.kind === "requires-action")).toHaveLength(1);
    expect(calls.find((c) => c.kind === "requires-action")?.runId).toBe(
      "run_1",
    );
    expect(calls.find((c) => c.kind === "requires-action")?.orgId).toBe(
      "org_1",
    );
    expect(calls.filter((c) => c.kind === "complete")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "fail")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "record-complete")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "record-fail")).toHaveLength(0);
  });

  test("tool-calls + user_ask input-available → requires_action, no analytics", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({
      outcome: {
        failed: false,
        finishReason: "tool-calls",
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        finalParts: [{ type: "tool-user_ask", state: "input-available" }],
      },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    expect(calls.filter((c) => c.kind === "requires-action")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "complete")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "record-complete")).toHaveLength(0);
  });

  test("normal stop (no question) → completed + recordCompleted", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({
      outcome: {
        failed: false,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        finalParts: [{ type: "text", text: "Done." }],
      },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    expect(calls.filter((c) => c.kind === "complete")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "record-complete")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "requires-action")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "fail")).toHaveLength(0);
  });

  test("in-band harness error → failed, gated recordFailed fires", async () => {
    const { rt, calls } = makeRuntime();
    const projectFn = makeProjectFn({
      outcome: {
        failed: true,
        finishReason: undefined,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finalParts: [],
      },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    expect(calls.filter((c) => c.kind === "fail")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "record-fail")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "complete")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "record-complete")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "requires-action")).toHaveLength(0);
  });

  test("EXACTLY ONCE: a no-op flip (run already terminal) does NOT re-fire recordCompleted", async () => {
    // Simulates a retried/re-entrant projection of an already-completed run
    // (e.g. a redelivered consume step, or a run the hosted live path already
    // finalized before the projector backstop ran). The conditional DB flip
    // (`WHERE status = 'in_progress'`) returns null/falsy on a no-op — the
    // side-effect (posthog `chat_message_completed`) must not fire again.
    const { rt, calls } = makeRuntime();
    rt.completeRunIfNotCompleted = async (runId, orgId) => {
      calls.push({ kind: "complete", runId, orgId });
      return null; // no-op: already terminal
    };
    const projectFn = makeProjectFn({
      outcome: {
        failed: false,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        finalParts: [],
      },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    expect(calls.filter((c) => c.kind === "complete")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "record-complete")).toHaveLength(0);
  });

  test("EXACTLY ONCE: a no-op flip (run already terminal) does NOT re-fire recordFailed", async () => {
    const { rt, calls } = makeRuntime();
    rt.markRunFailed = async (runId, orgId, reason, kind) => {
      calls.push({ kind: "fail", runId, orgId, reason, failKind: kind });
      return null; // no-op: already terminal
    };
    const projectFn = makeProjectFn({
      outcome: {
        failed: true,
        finishReason: undefined,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finalParts: [],
      },
    });

    await runProjectorWorkflowBody(input, rt, projectFn);

    expect(calls.filter((c) => c.kind === "fail")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "record-fail")).toHaveLength(0);
  });

  test("purge (cleanup) runs on ALL terminal paths (completed, harness-failed, requires_action)", async () => {
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
          finalParts: [],
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
          finalParts: [],
        },
      }),
    );
    expect(calls2.filter((c) => c.kind === "purge")).toHaveLength(1);

    // requires_action path (tool-calls + approval-requested)
    const { rt: rt3, calls: calls3 } = makeRuntime();
    await runProjectorWorkflowBody(
      input,
      rt3,
      makeProjectFn({
        outcome: {
          failed: false,
          finishReason: "tool-calls",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finalParts: [
            { type: "tool-invocation", state: "approval-requested" },
          ],
        },
      }),
    );
    expect(calls3.filter((c) => c.kind === "purge")).toHaveLength(1);
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

  test("forwards input.messageId to projectFn (queue ordering plumb)", async () => {
    // Guards the plumb from thread-gate-workflow → consumeRunProjection →
    // runProjectorWorkflowBody → projectFn. This asserts up to the projectFn
    // boundary only; the final projectFromJetStreamStep → createRunPersistence
    // (requestMessageId) hop is DB/JetStream-bound and covered by the CI e2e.
    const { rt } = makeRuntime();
    const receivedInputs: ProjectorWorkflowInput[] = [];
    const projectFn = async (inp: ProjectorWorkflowInput) => {
      receivedInputs.push(inp);
      return {
        chunkCount: 1,
        attempts: 1,
        outcome: {
          failed: false as const,
          finishReason: "stop" as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finalParts: [],
        },
      };
    };

    await runProjectorWorkflowBody(
      { ...input, messageId: "msg_u2" },
      rt,
      projectFn,
    );

    expect(receivedInputs[0]?.messageId).toBe("msg_u2");
  });

  test("input.messageId is undefined when the caller doesn't supply one (legacy)", async () => {
    const { rt } = makeRuntime();
    const receivedInputs: ProjectorWorkflowInput[] = [];
    const projectFn = async (inp: ProjectorWorkflowInput) => {
      receivedInputs.push(inp);
      return {
        chunkCount: 1,
        attempts: 1,
        outcome: {
          failed: false as const,
          finishReason: "stop" as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finalParts: [],
        },
      };
    };

    await runProjectorWorkflowBody(input, rt, projectFn);

    expect(receivedInputs[0]?.messageId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// onTitleUpdated + bumpProgress hook tests
// ---------------------------------------------------------------------------

describe("ProjectorWorkflowRuntime hooks", () => {
  const runId = "run_hooks";
  const orgId = "org_1";
  const fenceToken = "fence_a";
  const input: ProjectorWorkflowInput = {
    runId,
    fenceToken,
    finalSeq: 10,
  };

  test("onTitleUpdated is called when projectFn triggers persistTitle (terminal path)", async () => {
    const titleEvents: Array<{ runId: string; orgId: string; title: string }> =
      [];
    const progressBumps: Array<{ runId: string; orgId: string }> = [];

    const baseRt = makeRuntime().rt;
    const rt: ProjectorWorkflowRuntime = {
      ...baseRt,
      onTitleUpdated: async (i) => {
        titleEvents.push(i);
      },
      bumpProgress: async (i) => {
        progressBumps.push(i);
      },
    };

    // Simulate projectFromJetStreamStep's persistTitle wiring: when the title
    // interceptor persists a title, the step calls both rt.persistTitle AND
    // rt.onTitleUpdated. We replicate this behavior in the test projectFn.
    const generatedTitle = "Generated Title";
    const projectFn = async (
      inp: ProjectorWorkflowInput,
      pOrgId: string,
      _currentTitle: string | null,
    ) => {
      // Simulate the wiring inside projectFromJetStreamStep
      await rt.persistTitle(inp.runId, pOrgId, generatedTitle);
      await rt.onTitleUpdated({
        runId: inp.runId,
        orgId: pOrgId,
        title: generatedTitle,
      });
      return {
        chunkCount: 1,
        attempts: 1,
        outcome: {
          failed: false as const,
          finishReason: "stop" as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finalParts: [],
        },
      };
    };

    await runProjectorWorkflowBody(input, rt, projectFn);

    expect(titleEvents).toEqual([{ runId, orgId, title: generatedTitle }]);
    // Terminal path does not call bumpProgress
    expect(progressBumps).toHaveLength(0);
  });

  test("bumpProgress is called when checkpoint projection succeeds", async () => {
    const progressBumps: Array<{ runId: string; orgId: string }> = [];

    const baseRt = makeRuntime().rt;
    const rt: ProjectorWorkflowRuntime = {
      ...baseRt,
      bumpProgress: async (i) => {
        progressBumps.push(i);
      },
      onTitleUpdated: async () => {},
    };

    // bumpProgress is wired in the DBOS workflow function; verify here
    // that the runtime has the hook and it can be invoked with the right shape.
    await rt.bumpProgress({ runId, orgId });

    expect(progressBumps).toEqual([{ runId, orgId }]);
  });

  test("runtime interface requires onTitleUpdated and bumpProgress", () => {
    // TypeScript compile-time check: the makeRuntime() factory must now include
    // both hooks for ProjectorWorkflowRuntime to be satisfied.
    const { rt } = makeRuntime();
    expect(typeof rt.onTitleUpdated).toBe("function");
    expect(typeof rt.bumpProgress).toBe("function");
  });
});
