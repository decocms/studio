import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import { PROJECT_RUN_MAX_ATTEMPTS, projectRun } from "./project-run";

function okPersistence(): HarnessStreamPersistence {
  return {
    emitStepParts: async () => {},
    emitFinal: async () => {},
    emitError: async () => {},
  };
}

function helloChunks(): UIMessageChunk[] {
  return [
    { type: "start" } as UIMessageChunk,
    { type: "text-start", id: "t" } as UIMessageChunk,
    { type: "text-delta", id: "t", delta: "hi" } as UIMessageChunk,
    { type: "text-end", id: "t" } as UIMessageChunk,
    { type: "finish", finishReason: "stop" } as UIMessageChunk,
  ];
}

/** A run whose stream carries partial text then an AI-SDK `error` chunk —
 *  the shape consumeRelayedRun synthesizes from a harness error EVENT. */
function errorChunks(): UIMessageChunk[] {
  return [
    { type: "start", messageId: "m1" } as UIMessageChunk,
    { type: "start-step" } as UIMessageChunk,
    { type: "text-start", id: "t" } as UIMessageChunk,
    { type: "text-delta", id: "t", delta: "partial" } as UIMessageChunk,
    { type: "text-end", id: "t" } as UIMessageChunk,
    { type: "error", errorText: "harness_error: boom" } as UIMessageChunk,
  ];
}

describe("projectRun", () => {
  test("a healthy run projects once and is not sent to the DLQ", async () => {
    const dlq: Array<{ runId: string; error: unknown }> = [];
    const result = await projectRun({
      runId: "run_1",
      chunks: helloChunks(),
      persistence: okPersistence(),
      onDlq: async (runId, error) => {
        dlq.push({ runId, error });
      },
      backoffMs: () => 0,
    });
    expect(result.ok).toBe(true);
    expect(dlq).toHaveLength(0);
  });

  test("a poison run retries to exhaustion then surfaces to the DLQ (does not stall)", async () => {
    let attempts = 0;
    const dlq: Array<{ runId: string; error: unknown }> = [];
    const poison: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {
        attempts++;
        throw new Error("unprojectable");
      },
      emitError: async () => {},
    };
    const result = await projectRun({
      runId: "run_1",
      chunks: helloChunks(),
      persistence: poison,
      onDlq: async (runId, error) => {
        dlq.push({ runId, error });
      },
      backoffMs: () => 0,
    });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(PROJECT_RUN_MAX_ATTEMPTS);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.runId).toBe("run_1");
    expect((dlq[0]!.error as Error).message).toBe("unprojectable");
  });

  test("an error-chunk run persists an error part + finish anchor, then DLQs (→ status failed)", async () => {
    // The error chunk drives consumeHarnessStream.onError → emitError (which
    // persists BOTH an `error` part and a `finish` anchor) and sets the source
    // error → projectChunks re-throws → projectRun exhausts retries and DLQs.
    // The workflow's failRunStep then marks the run `failed`. The persistence is
    // idempotent across retries (PartEmitter ON CONFLICT), so the error+finish
    // parts land even though projectRun returns ok:false.
    const emittedErrors: Array<[string, string]> = [];
    const persistence: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {},
      emitError: async (id, text) => {
        emittedErrors.push([id, text]);
      },
    };
    const dlq: Array<{ runId: string; error: unknown }> = [];
    const result = await projectRun({
      runId: "run_1",
      chunks: errorChunks(),
      persistence,
      onDlq: async (runId, error) => {
        dlq.push({ runId, error });
      },
      backoffMs: () => 0,
    });
    // The run is NOT completed — it is sent to the DLQ so the workflow fails it.
    expect(result.ok).toBe(false);
    expect(dlq).toHaveLength(1);
    // emitError ran (it persists the error part + finish anchor in PartEmitter).
    expect(emittedErrors.length).toBeGreaterThanOrEqual(1);
    expect(emittedErrors[0]![1]).toBe("harness_error: boom");
  });

  test("a transient failure that recovers before exhaustion succeeds without DLQ", async () => {
    let calls = 0;
    const dlq: unknown[] = [];
    const flaky: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {
        calls++;
        if (calls < 2) throw new Error("transient");
      },
      emitError: async () => {},
    };
    const result = await projectRun({
      runId: "run_1",
      chunks: helloChunks(),
      persistence: flaky,
      onDlq: async () => {
        dlq.push(true);
      },
      backoffMs: () => 0,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(dlq).toHaveLength(0);
  });
});
