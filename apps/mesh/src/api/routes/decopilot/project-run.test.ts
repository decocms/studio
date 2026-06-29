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

function helloChunks(messageId?: string): UIMessageChunk[] {
  return [
    { type: "start", ...(messageId ? { messageId } : {}) } as UIMessageChunk,
    { type: "text-start", id: "t" } as UIMessageChunk,
    { type: "text-delta", id: "t", delta: "hi" } as UIMessageChunk,
    { type: "text-end", id: "t" } as UIMessageChunk,
    { type: "finish", finishReason: "stop" } as UIMessageChunk,
  ];
}

/** A run whose stream carries partial text then an AI-SDK `error` chunk —
 *  the shape link ingest synthesizes from a harness error EVENT. */
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
      fenceToken: "fence_1",
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
      fenceToken: "fence_1",
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

  test("an error-chunk run returns ok:true with outcome.failed=true (→ workflow marks it failed)", async () => {
    // The error chunk drives consumeHarnessStream.onError → emitError (which
    // persists BOTH an `error` part and a `finish` anchor). projectChunks now
    // returns {failed:true} instead of throwing, so projectRun returns ok:true
    // and carries outcome.failed=true. The workflow's markRunFailed step uses
    // this verdict to mark the run `failed` (Task 6). The run is NOT DLQ'd.
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
      fenceToken: "fence_1",
      chunks: errorChunks(),
      persistence,
      onDlq: async (runId, error) => {
        dlq.push({ runId, error });
      },
      backoffMs: () => 0,
    });
    // The run IS completed — outcome.failed carries the harness verdict.
    expect(result.ok).toBe(true);
    expect(result.outcome?.failed).toBe(true);
    expect(dlq).toHaveLength(0);
    // emitError ran (it persists the error part + finish anchor in PartEmitter).
    expect(emittedErrors.length).toBeGreaterThanOrEqual(1);
    expect(emittedErrors[0]![1]).toBe("harness_error: boom");
  });

  test("ProjectRunResult carries the harness outcome on success (Task 5)", async () => {
    // A healthy run: outcome.failed=false.
    const result = await projectRun({
      runId: "r1",
      fenceToken: "fence_1",
      chunks: helloChunks(),
      persistence: okPersistence(),
      onDlq: async () => {},
      backoffMs: () => 0,
    });
    expect(result.ok).toBe(true);
    expect(result.outcome?.failed).toBe(false);
  });

  test("two turns of one thread (same runId, different fence) persist DISJOINT message ids", async () => {
    // Regression #4044: cross-turn collision dropped a fully-generated 2nd-turn
    // response ("No response was generated"). runId == threadId is STABLE across
    // turns; only the per-turn harness start.messageId differs. The fold passes
    // that harness-stamped id verbatim to every persisted message for that turn,
    // so turns carrying distinct harness ids produce distinct persisted ids →
    // ON CONFLICT DO NOTHING never drops turn 2's rows against turn 1's.
    const capture = () => {
      const ids: string[] = [];
      const persistence: HarnessStreamPersistence = {
        emitStepParts: async (m) => {
          ids.push(m.id);
        },
        emitFinal: async (m) => {
          ids.push(m.id);
        },
        emitError: async () => {},
      };
      return { ids, persistence };
    };

    const turn1 = capture();
    await projectRun({
      runId: "thread_1",
      fenceToken: "fence_a",
      chunks: helloChunks("m_a"),
      persistence: turn1.persistence,
      onDlq: async () => {},
      backoffMs: () => 0,
    });

    const turn2 = capture();
    await projectRun({
      runId: "thread_1",
      fenceToken: "fence_b",
      chunks: helloChunks("m_b"),
      persistence: turn2.persistence,
      onDlq: async () => {},
      backoffMs: () => 0,
    });

    // Every persisted id for turn 1 must equal the harness-stamped id "m_a"
    // (verbatim flow-through: start.messageId → fold → persistence).
    expect(turn1.ids.length).toBeGreaterThan(0);
    expect(turn1.ids.every((id) => id === "m_a")).toBe(true);

    // Every persisted id for turn 2 must equal the harness-stamped id "m_b".
    expect(turn2.ids.length).toBeGreaterThan(0);
    expect(turn2.ids.every((id) => id === "m_b")).toBe(true);

    // Disjointness follows from distinct harness ids, not from RNG:
    // no id from turn 1 appears in turn 2 → ON CONFLICT DO NOTHING is safe.
    expect(turn1.ids.some((id) => turn2.ids.includes(id))).toBe(false);
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
      fenceToken: "fence_1",
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
