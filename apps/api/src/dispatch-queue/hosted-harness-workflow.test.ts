import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "@decocms/shared/std";
import { synthesizedErrorMessageId } from "@/api/routes/decopilot/message-ids";
import type { WithLastAckSeq } from "@/api/routes/decopilot/ingest-run";
import { buildRunStatusChunk } from "@/api/routes/decopilot/run-status-stage";
import type { StudioContext } from "@/core/studio-context";
import { acquireHostedRunSlot, hostedRunStats } from "./hosted-run-concurrency";
import {
  buildTerminalErrorChunks,
  hostedChildWorkflowId,
  type HostedHarnessInput,
  type HostedHarnessRuntime,
  publishHostedHarnessFailure,
  runHostedHarness,
  type SerializableDispatchRunInput,
  setHostedHarnessRuntime,
  terminalErrorStartSeq,
} from "./hosted-harness-workflow";

describe("buildTerminalErrorChunks", () => {
  test("carries the REAL err.message verbatim — never a masked/generic string", () => {
    const result = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      new Error("tool call exploded: ECONNRESET talking to upstream MCP"),
    );

    expect(result.errorChunk).toEqual({
      type: "error",
      errorText: "tool call exploded: ECONNRESET talking to upstream MCP",
    });
  });

  test("stringifies a non-Error thrown value", () => {
    const result = buildTerminalErrorChunks("thread-1", "fence-a", "boom");

    expect(result.errorChunk).toEqual({ type: "error", errorText: "boom" });
  });

  test("uses the SAME deterministic id the projector computes for its own synthesized error", () => {
    const result = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      new Error("x"),
    );

    // The durable projector independently calls synthesizedErrorMessageId with
    // the same (runId, fenceToken) when IT synthesizes an error message from
    // this same chunk (see projector-workflow.ts) — so a projector retry's
    // emitError collapses onto this SAME row (ON CONFLICT DO NOTHING) instead
    // of duplicating it.
    expect(result.messageId).toBe(
      synthesizedErrorMessageId("thread-1", "fence-a"),
    );
  });

  test("defaults the error chunk and paired {done} sentinel to seq 1", () => {
    const result = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      new Error("x"),
    );

    expect(result.seq).toBe(1);
    expect(result.finalSeq).toBe(1);
  });

  test("continues the run's seq counter from an explicit startSeq", () => {
    const result = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      new Error("x"),
      7,
    );

    expect(result.seq).toBe(7);
    expect(result.finalSeq).toBe(7);
  });

  test("distinct turns of the same thread never collide", () => {
    const turnOne = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      new Error("x"),
    );
    const turnTwo = buildTerminalErrorChunks(
      "thread-1",
      "fence-b",
      new Error("x"),
    );

    expect(turnOne.messageId).not.toBe(turnTwo.messageId);
  });
});

describe("terminalErrorStartSeq", () => {
  test("returns undefined for a non-Error thrown value", () => {
    expect(terminalErrorStartSeq("boom")).toBeUndefined();
  });

  test("returns undefined when the error carries no lastAckSeq (setup failure, no chunk ever published)", () => {
    expect(terminalErrorStartSeq(new Error("user membership lost"))).toBe(
      undefined,
    );
  });

  test("returns lastAckSeq + 1 when ingestRun stamped a mid-stream failure", () => {
    const err = new Error("source failed mid-stream") as Error & WithLastAckSeq;
    err.lastAckSeq = 2;
    expect(terminalErrorStartSeq(err)).toBe(3);
  });

  test("returns 1 (via lastAckSeq=0) when the very first publish failed — nothing was ever confirmed", () => {
    const err = new Error("publishRawChunk failed") as Error & WithLastAckSeq;
    err.lastAckSeq = 0;
    expect(terminalErrorStartSeq(err)).toBe(1);
  });

  test("end-to-end: feeds buildTerminalErrorChunks to continue the run's seq counter", () => {
    const err = new Error("source failed mid-stream") as Error & WithLastAckSeq;
    err.lastAckSeq = 5;
    const result = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      err,
      terminalErrorStartSeq(err),
    );
    expect(result.seq).toBe(6);
    expect(result.finalSeq).toBe(6);
  });
});

// Finding 1 regression: a mid-stream `dispatchRunFn` failure used to run with
// `retriesAllowed: true` on the `runHostedHarness` DBOS step, so a real
// application-level throw (which, post-T2's pump-swallow fix, now propagates
// instead of being swallowed) re-executed the ENTIRE agent loop up to 3 more
// times — real LLM cost, a delayed terminal, and a risk of the projector
// splicing two divergent generations into one message (the fence is stable
// across attempts while the pump's seq counter restarts at 0 each attempt).
// Fixed by setting `retriesAllowed: false`: an application-level throw is a
// DELIBERATE terminal that should flow straight to `hostedHarnessWorkflowFn`'s
// catch, exactly once.
describe("hostedHarnessWorkflowFn's try/catch contract (Finding 1)", () => {
  // `hostedHarnessWorkflowFn` itself isn't exported and calls `DBOS.runStep`,
  // which throws immediately outside a launched DBOS instance
  // (`ensureDBOSIsLaunched`) — this unit-test tier doesn't stand one up (repo
  // policy: no DBOS mocks). So this test calls `runHostedHarness` /
  // `publishHostedHarnessFailure` directly to reconstruct the try/catch body
  // verbatim, minus the `DBOS.runStep` wrapping. That documents INTENT — "the
  // dispatch fn runs exactly once, and a caught failure publishes exactly one
  // fenced terminal" — rather than exercising DBOS's actual retry/recovery
  // machinery. The "no retry" half of the fix (the actual `retriesAllowed`
  // config DBOS enforces) is separately verified below by reading the real
  // registration call site.

  const request = {
    organizationId: "org-1",
    userId: "user-1",
  } as SerializableDispatchRunInput;

  const input: HostedHarnessInput = {
    runId: "run-1",
    fenceToken: "fence-1",
    threadId: "thread-1",
    request,
  };

  function runtimeWithDispatchFn(
    dispatchRunFn: HostedHarnessRuntime["dispatchRunFn"],
  ) {
    const streamBuffer = {
      publishRawChunk: mock(() => Promise.resolve(true)),
      publishDone: mock(() => Promise.resolve(true)),
    } as unknown as NonNullable<HostedHarnessRuntime["deps"]["streamBuffer"]>;
    const rt: HostedHarnessRuntime = {
      dispatchRunFn,
      studioContextFactory: async () => null,
      deps: {
        runRegistry: {} as HostedHarnessRuntime["deps"]["runRegistry"],
        cancelBroadcast: {} as HostedHarnessRuntime["deps"]["cancelBroadcast"],
        streamBuffer,
      },
    };
    setHostedHarnessRuntime(rt);
    return { streamBuffer };
  }

  test("a dispatchRunFn that throws mid-run: the catch publishes the fenced terminal, and the dispatch fn ran EXACTLY ONCE", async () => {
    const boom = new Error("harness exploded mid-stream");
    const dispatchRunFn = mock(() => Promise.reject(boom));
    const { streamBuffer } = runtimeWithDispatchFn(dispatchRunFn);
    const fakeCtx = {} as StudioContext;

    let caught: unknown;
    try {
      await runHostedHarness(input, fakeCtx);
    } catch (err) {
      caught = err;
      await publishHostedHarnessFailure(input, err);
    }

    expect(caught).toBe(boom);
    expect(dispatchRunFn).toHaveBeenCalledTimes(1);
    expect(streamBuffer.publishRawChunk).toHaveBeenCalledTimes(1);
    expect(streamBuffer.publishDone).toHaveBeenCalledTimes(1);
  });

  test("registers the runHostedHarness step with retriesAllowed: false", () => {
    // Source-text assertion (same technique as
    // dbos/workflow-source-guard.test.ts) — DBOS's actual retry-on-throw
    // behavior can't be exercised without a launched DBOS instance, so this
    // reads the real registration call site instead of a stand-in.
    const src = readFileSync(
      join(import.meta.dir, "hosted-harness-workflow.ts"),
      "utf8",
    );
    const marker = 'name: "runHostedHarness"';
    const idx = src.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    const stepConfig = src.slice(idx, idx + 100);
    expect(stepConfig).toContain("retriesAllowed: false");
  });
});

// unified-control-plane T9 proof obligation 1 (carried from T1's review): the
// "half-terminal" invariant — `{done}` must NEVER be published when the
// error-chunk publish itself failed (returned false OR threw), and the
// child's outer catch must swallow that failure rather than rethrow (per
// `hostedHarnessWorkflowFn`'s guarantee: it always returns normally). This is
// best proved as a unit test on `publishHostedHarnessFailure`'s ordering
// rather than forced into e2e (there is no black-box way to make JetStream's
// publish call fail on demand from Playwright).
describe("half-terminal invariant (T9 proof obligation 1): done is never published when the error-terminal publish itself failed", () => {
  const request = {
    organizationId: "org-1",
    userId: "user-1",
  } as SerializableDispatchRunInput;

  const input: HostedHarnessInput = {
    runId: "run-half-terminal",
    fenceToken: "fence-half-terminal",
    threadId: "thread-half-terminal",
    request,
  };

  test("publishRawChunk returns false → publishDone is NOT called, and publishHostedHarnessFailure itself resolves without throwing", async () => {
    const streamBuffer = {
      publishRawChunk: mock(() => Promise.resolve(false)),
      publishDone: mock(() => Promise.resolve(true)),
    } as unknown as NonNullable<HostedHarnessRuntime["deps"]["streamBuffer"]>;
    setHostedHarnessRuntime({
      dispatchRunFn: mock(() => Promise.resolve({ taskId: "t" })),
      studioContextFactory: async () => null,
      deps: {
        runRegistry: {} as HostedHarnessRuntime["deps"]["runRegistry"],
        cancelBroadcast: {} as HostedHarnessRuntime["deps"]["cancelBroadcast"],
        streamBuffer,
      },
    });

    await expect(
      publishHostedHarnessFailure(input, new Error("harness exploded")),
    ).resolves.toBeUndefined();

    expect(streamBuffer.publishRawChunk).toHaveBeenCalledTimes(1);
    expect(streamBuffer.publishDone).not.toHaveBeenCalled();
  });

  test("publishRawChunk throws → publishDone is NOT called (the rejection propagates out of publishHostedHarnessFailure itself, unswallowed at this layer)", async () => {
    const publishErr = new Error("JetStream unavailable");
    const streamBuffer = {
      publishRawChunk: mock(() => Promise.reject(publishErr)),
      publishDone: mock(() => Promise.resolve(true)),
    } as unknown as NonNullable<HostedHarnessRuntime["deps"]["streamBuffer"]>;
    setHostedHarnessRuntime({
      dispatchRunFn: mock(() => Promise.resolve({ taskId: "t" })),
      studioContextFactory: async () => null,
      deps: {
        runRegistry: {} as HostedHarnessRuntime["deps"]["runRegistry"],
        cancelBroadcast: {} as HostedHarnessRuntime["deps"]["cancelBroadcast"],
        streamBuffer,
      },
    });

    await expect(
      publishHostedHarnessFailure(input, new Error("harness exploded")),
    ).rejects.toBe(publishErr);

    expect(streamBuffer.publishRawChunk).toHaveBeenCalledTimes(1);
    expect(streamBuffer.publishDone).not.toHaveBeenCalled();
  });

  test("end-to-end: dispatchRunFn throws AND the error-terminal publish itself throws → the reconstructed workflow body (mirroring hostedHarnessWorkflowFn's outer .catch) still returns normally, never rethrows", async () => {
    const dispatchErr = new Error("harness exploded mid-stream");
    const publishErr = new Error("JetStream unavailable");
    const streamBuffer = {
      publishRawChunk: mock(() => Promise.reject(publishErr)),
      publishDone: mock(() => Promise.resolve(true)),
    } as unknown as NonNullable<HostedHarnessRuntime["deps"]["streamBuffer"]>;
    setHostedHarnessRuntime({
      dispatchRunFn: mock(() => Promise.reject(dispatchErr)),
      studioContextFactory: async () => null,
      deps: {
        runRegistry: {} as HostedHarnessRuntime["deps"]["runRegistry"],
        cancelBroadcast: {} as HostedHarnessRuntime["deps"]["cancelBroadcast"],
        streamBuffer,
      },
    });

    // Reconstruct hostedHarnessWorkflowFn's full try/catch — including the
    // OUTER `.catch` wrapped around the `publishHostedHarnessFailure` step —
    // the same technique the "Finding 1" describe block above uses, since
    // this test tier can't launch a real DBOS.runStep. See that block's
    // comment for why.
    let escaped: unknown;
    try {
      try {
        await runHostedHarness(input, {} as StudioContext);
      } catch (err) {
        await publishHostedHarnessFailure(input, err).catch(() => {
          // mirrors hostedHarnessWorkflowFn's console.error-and-swallow —
          // "there's nothing more this workflow can durably do" per its
          // comment.
        });
      }
    } catch (err) {
      escaped = err;
    }

    // The child catch swallows, never rethrows: nothing escapes the
    // reconstructed workflow body.
    expect(escaped).toBeUndefined();
    // done was never published — the half-terminal invariant.
    expect(streamBuffer.publishRawChunk).toHaveBeenCalledTimes(1);
    expect(streamBuffer.publishDone).not.toHaveBeenCalled();
  });
});

// Regression: a run parked at the per-pod concurrency cap published NOTHING
// while it waited. The parent gate is already live-tailing the run's subject
// with a RUN_IDLE_TIMEOUT_MS silence window, so a queue longer than that window
// failed the turn as a liveness breach before the loop had started — and the
// child then ran anyway under a fence nobody was projecting. The parked run now
// publishes `waiting-capacity` (which both resets that window and is the only
// feedback a queued run gives the UI).
describe("a run queued at the concurrency cap", () => {
  const input: HostedHarnessInput = {
    runId: "run-parked",
    fenceToken: "fence-parked",
    threadId: "thread-parked",
    request: {
      organizationId: "org-1",
      userId: "user-1",
    } as SerializableDispatchRunInput,
  };

  test("publishes waiting-capacity while parked, and starts the loop only once a slot frees", async () => {
    // Saturate the real gate by holding every slot it has, so the run under
    // test genuinely parks (no env/module games — the cap is read once at
    // import time).
    const held = await Promise.all(
      Array.from({ length: hostedRunStats().max }, () =>
        acquireHostedRunSlot(),
      ),
    );
    try {
      const dispatchRunFn = mock(() => Promise.resolve({ taskId: "t" }));
      const streamBuffer = {
        publishRawChunk: mock(() => Promise.resolve(true)),
        publishDone: mock(() => Promise.resolve(true)),
      } as unknown as NonNullable<HostedHarnessRuntime["deps"]["streamBuffer"]>;
      setHostedHarnessRuntime({
        dispatchRunFn,
        studioContextFactory: async () => null,
        deps: {
          runRegistry: {} as HostedHarnessRuntime["deps"]["runRegistry"],
          cancelBroadcast:
            {} as HostedHarnessRuntime["deps"]["cancelBroadcast"],
          streamBuffer,
        },
      });

      const run = runHostedHarness(input, {} as StudioContext);
      // Let the park's publish settle (it is fire-and-forget by design — the
      // status must never delay the run).
      await sleep(0);

      expect(streamBuffer.publishRawChunk).toHaveBeenCalledWith(
        input.runId,
        buildRunStatusChunk("waiting-capacity"),
      );
      expect(dispatchRunFn).not.toHaveBeenCalled();

      held[0]?.();
      await run;
      expect(dispatchRunFn).toHaveBeenCalledTimes(1);
    } finally {
      for (const release of held) release();
    }
  });
});

describe("hostedChildWorkflowId", () => {
  test("derives the deterministic child workflow id from (runId, fenceToken)", () => {
    expect(hostedChildWorkflowId("run-1", "fence-a")).toBe(
      "decopilot-hosted:run-1:fence-a",
    );
  });

  test("distinct fence tokens on the same run produce distinct ids (no cross-turn collision)", () => {
    expect(hostedChildWorkflowId("run-1", "fence-a")).not.toBe(
      hostedChildWorkflowId("run-1", "fence-b"),
    );
  });

  test("is the SAME id both cancelHostedHarness and startHostedHarness derive — single source of truth", () => {
    // Source-text assertion: both call sites must read through this helper
    // rather than reconstructing the `decopilot-hosted:` string independently
    // (the exact drift this export exists to prevent — see the module doc
    // comment). unified-control-plane T7 (stop cancels the live hosted
    // child) reuses `cancelHostedHarness` from `cancelActiveThreadRun`
    // (routes.ts's stop path) instead of adding a third direct call site —
    // see routes.test.ts's "cancelActiveThreadRun (T7...)" describe block
    // for that regression coverage.
    const src = readFileSync(
      join(import.meta.dir, "hosted-harness-workflow.ts"),
      "utf8",
    );
    const startMatches = src.match(
      /startWorkflow\(hostedHarnessWorkflow, \{\s*workflowID: hostedChildWorkflowId\(/,
    );
    const cancelMatches = src.match(/cancelWorkflow\(hostedChildWorkflowId\(/);
    expect(startMatches).not.toBeNull();
    expect(cancelMatches).not.toBeNull();
  });
});

// T3 regression: `startHostedHarness` must NOT await the child's result — the
// gate no longer blocks on the hosted agent loop before proceeding to its
// consume step (that coupling is what this task removes). Exercising the
// real `DBOS.startWorkflow` call requires a launched DBOS instance (repo
// policy: no DBOS mocks), so — same technique as the `retriesAllowed: false`
// regression above — this reads the real function body directly.
describe("startHostedHarness (T3: start-only, no getResult await)", () => {
  test("does not call handle.getResult()", () => {
    const src = readFileSync(
      join(import.meta.dir, "hosted-harness-workflow.ts"),
      "utf8",
    );
    const marker = "export async function startHostedHarness(";
    const idx = src.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    const nextFnStart = src.indexOf("\nexport async function", idx + 1);
    const body = src.slice(idx, nextFnStart === -1 ? undefined : nextFnStart);
    expect(body).toContain("DBOS.startWorkflow(hostedHarnessWorkflow");
    expect(body).not.toContain("getResult()");
  });
});
