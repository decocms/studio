import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  claimRunFenceForDispatch,
  setThreadGateRuntime,
  THREAD_GATE_PARTITION_CONCURRENCY,
  THREAD_GATE_QUEUE,
  type ThreadGateRuntime,
} from "./thread-gate-workflow";
import type { SerializableDispatchRunInput } from "./thread-gate-workflow";

describe("threadGateWorkflow plumbing", () => {
  it("exposes the queue name and per-thread concurrency cap", () => {
    expect(THREAD_GATE_QUEUE).toBe("thread-gate");
    // Concurrency=1 per partition (per thread) is what gives us
    // serialization — Phase 3 relies on this for "queue behavior".
    expect(THREAD_GATE_PARTITION_CONCURRENCY).toBe(1);
  });

  it("setThreadGateRuntime accepts a runtime shape", () => {
    const rt: ThreadGateRuntime = {
      studioContextFactory: async () => null,
      deps: {
        runRegistry: {} as ThreadGateRuntime["deps"]["runRegistry"],
        cancelBroadcast: {} as ThreadGateRuntime["deps"]["cancelBroadcast"],
        streamBuffer: undefined,
      },
    };
    expect(() => setThreadGateRuntime(rt)).not.toThrow();
  });
});

describe("claimRunFenceForDispatch", () => {
  const request = {
    taskId: "thread-1",
    messageId: "msg-1",
    runFenceToken: "submit-fence",
    organizationId: "org-1",
    userId: "user-1",
    models: {
      credentialId: "cred-1",
      thinking: { id: "model-1" },
    },
    temperature: 0,
    toolApprovalLevel: "auto",
    mode: "default",
  } as SerializableDispatchRunInput;

  it("preserves the submit-time run fence token", () => {
    const claim = claimRunFenceForDispatch(request, () => "new-fence");

    expect(claim.runFenceToken).toBe("submit-fence");
    expect(claim.claimedRequest).toBe(request);
    expect(claim.shouldPersistFence).toBe(false);
  });

  it("mints and marks legacy requests for persistence when no submit fence exists", () => {
    const { runFenceToken: _ignored, ...legacyRequest } = request;
    const claim = claimRunFenceForDispatch(
      legacyRequest as SerializableDispatchRunInput,
      () => "legacy-fence",
    );

    expect(claim.runFenceToken).toBe("legacy-fence");
    expect(claim.claimedRequest.runFenceToken).toBe("legacy-fence");
    expect(claim.shouldPersistFence).toBe(true);
  });
});

// The dispatch step requires a live StudioContext, real storage, and DBOS, so
// repo policy keeps it out of unit tests. Pin the security-sensitive ordering
// in the real function body: persisted authority must be checked before either
// hosted status publication or the run-fence write.
describe("dispatchRunAndWaitStep authority ordering", () => {
  const src = readFileSync(
    join(import.meta.dir, "thread-gate-workflow.ts"),
    "utf8",
  );
  const fnStart = src.indexOf("async function dispatchRunAndWaitStep(");
  const fnEnd = src.indexOf(
    "\nasync function trackMessageStartedStep",
    fnStart,
  );
  const body = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

  it("checks the persisted hosted runtime before status or fence side effects", () => {
    const loadThreadIdx = body.indexOf("storage.threads.get(taskId)");
    const authorityIdx = body.indexOf("resolveThreadAuthority(thread");
    const runtimeIdx = body.indexOf("isHostedDecopilotRuntime({");
    const statusIdx = body.indexOf("publishRunStatusStage(");
    const fenceIdx = body.indexOf("storage.threads.setRunFence(");

    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    expect(loadThreadIdx).toBeGreaterThan(-1);
    expect(authorityIdx).toBeGreaterThan(loadThreadIdx);
    expect(runtimeIdx).toBeGreaterThan(authorityIdx);
    expect(statusIdx).toBeGreaterThan(runtimeIdx);
    expect(fenceIdx).toBeGreaterThan(runtimeIdx);
  });
});

// `runDispatchSteps` itself calls `DBOS.runStep`, which requires a launched
// DBOS instance (repo policy: no DBOS mocks) — so, same technique as
// hosted-harness-workflow.test.ts's `retriesAllowed: false` / `getResult()`
// regressions, this reads the real function body to pin the fix-round-1
// restructuring: the hosted child's START call must sit INSIDE the dispatch
// try/catch (a failure to even START the child is a setup failure like any
// other dispatch throw — it must fire trackMessageFailed + rethrow, fail the
// gate attempt, and let DBOS recovery re-run it, not be swallowed into a
// 30-minute idle-timeout misfire), and the gate must never again await the
// child's result before consuming.
describe("runDispatchSteps step ordering (hosted child start shares the dispatch try/catch; only its RESULT is fire-and-forget)", () => {
  const src = readFileSync(
    join(import.meta.dir, "thread-gate-workflow.ts"),
    "utf8",
  );
  const fnStart = src.indexOf("export async function runDispatchSteps(");
  const fnEnd = src.indexOf("\nasync function threadGateWorkflowFn", fnStart);
  const body = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

  it("locates the function", () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
  });

  it("starts the hosted child INSIDE the dispatch try block (after the dispatch step, before the catch), and consumes AFTER the try/catch closes", () => {
    const tryIdx = body.indexOf("try {");
    const dispatchStepIdx = body.indexOf('name: "dispatchRunAndWait",');
    const startCallIdx = body.indexOf("await startHostedHarness(");
    const catchIdx = body.indexOf("} catch (err) {");
    const rethrowIdx = body.indexOf("throw err;", catchIdx);
    const consumeCallIdx = body.indexOf("consumeRunProjection({");

    expect(tryIdx).toBeGreaterThan(-1);
    expect(dispatchStepIdx).toBeGreaterThan(tryIdx);
    // The hosted-start call is textually AFTER the dispatch step resolves,
    // but still INSIDE the same try block — a throw here reaches the exact
    // same catch as a `dispatchRunAndWaitStep` throw.
    expect(startCallIdx).toBeGreaterThan(dispatchStepIdx);
    expect(catchIdx).toBeGreaterThan(startCallIdx);
    expect(rethrowIdx).toBeGreaterThan(catchIdx);
    // The consume step is unconditional and comes after the try/catch closes.
    expect(consumeCallIdx).toBeGreaterThan(rethrowIdx);
  });

  it("does NOT await the child's result (no getResult call in the function body)", () => {
    expect(body).not.toContain("getResult()");
  });

  it("a hosted-start throw reaches the SAME catch as a dispatch throw — no separate swallow-and-log wrapper", () => {
    const firstCatchIdx = body.indexOf("} catch (err) {");
    const secondCatchIdx = body.indexOf("} catch (err) {", firstCatchIdx + 1);
    // Exactly one catch block in the whole function — the hosted-start call
    // no longer has its own try/catch; that swallow-and-log wrapper is gone.
    expect(firstCatchIdx).toBeGreaterThan(-1);
    expect(secondCatchIdx).toBe(-1);
    expect(body).not.toContain("falling through to consume");
    expect(body).not.toContain("console.error");
    // The shared catch still fires trackMessageFailed + rethrows.
    const catchBody = body.slice(firstCatchIdx, rethrowIdxOf(body));
    expect(catchBody).toContain("trackMessageFailedStep");
  });
});

function rethrowIdxOf(body: string): number {
  const catchIdx = body.indexOf("} catch (err) {");
  const idx = body.indexOf("throw err;", catchIdx);
  return idx === -1 ? body.length : idx + "throw err;".length;
}
