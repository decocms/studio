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
