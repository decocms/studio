/**
 * Unit tests for `buildAgentSandboxUiStream` — the agent-sandbox producer in
 * dispatch-run. Post-cutover (Phase C) this is unconditional: raw harness
 * chunks are published to the stream buffer with seq-keyed `Nats-Msg-Id`s via
 * `ingestRun`, the consumer hooks fire once, and the durable projector is the
 * sole DB writer — so the inline `persistTitle` is a NO-OP (never invoked).
 *
 * dispatch-run transitively imports `@/api/app`; the same `@/tools/sandbox/start`
 * stub the sibling dispatch-sandbox test uses keeps the re-export resolvable.
 */
import { describe, expect, it, mock } from "bun:test";
import type { UIMessageChunk } from "ai";

mock.module("@/tools/sandbox/start", () => ({
  ensureSandbox: async () => {
    throw new Error("ensureSandbox must not be called in these unit tests");
  },
  SANDBOX_START: { name: "SANDBOX_START" },
}));

const { buildAgentSandboxUiStream } = await import("./dispatch-run");

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* harnessChunks(): AsyncIterable<UIMessageChunk> {
  yield { type: "text-start", id: "t" } as UIMessageChunk;
  yield { type: "text-delta", id: "t", delta: "hi" } as UIMessageChunk;
  yield { type: "finish" } as UIMessageChunk;
}

function makeDeps() {
  const publishedRaw: Array<{ chunk: unknown; msgId?: string }> = [];
  const publishedDone: Array<{ fenceToken: string; finalSeq: number }> = [];
  const persistedTitles: Array<{ threadId: string; title: string }> = [];
  return {
    publishedRaw,
    publishedDone,
    persistedTitles,
    streamBuffer: {
      publishRawChunk: async (
        _taskId: string,
        chunk: unknown,
        opts?: { msgId?: string },
      ) => {
        publishedRaw.push({ chunk, msgId: opts?.msgId });
        return true;
      },
      publishDone: async (
        _taskId: string,
        fenceToken: string,
        finalSeq: number,
      ) => {
        publishedDone.push({ fenceToken, finalSeq });
        return true;
      },
    },
    title: {
      currentThreadTitle: null,
      threadId: "r",
      persistTitle: async (threadId: string, title: string) => {
        persistedTitles.push({ threadId, title });
      },
    },
  };
}

describe("buildAgentSandboxUiStream", () => {
  it("publishes seq-keyed raw chunks via ingestRun and fires hooks once", async () => {
    const d = makeDeps();
    let finishCount = 0;
    const stream = buildAgentSandboxUiStream({
      runId: "r",
      fenceToken: "f",
      chunks: harnessChunks(),
      streamBuffer: d.streamBuffer,
      title: d.title,
      hooks: {
        onFinish: () => {
          finishCount++;
        },
      },
    });
    await drain(stream);

    expect(d.publishedRaw.map((p) => p.msgId)).toEqual([
      "r:f:1",
      "r:f:2",
      "r:f:3",
    ]);
    expect(d.persistedTitles).toEqual([]);
    expect(finishCount).toBe(1);
    // Authoritative {done} marker fires once, fence-scoped to the last seq.
    expect(d.publishedDone).toEqual([{ fenceToken: "f", finalSeq: 3 }]);
  });

  it("forwards checkpointPublisher to ingestRun — it is called on ackSeq advance", async () => {
    // Verify that a checkpointPublisher passed to buildAgentSandboxUiStream is
    // forwarded into the ingestRun deps and invoked when the contiguous ackSeq
    // floor advances. lastCheckpointAt starts at 0, so the FIRST advance always
    // passes the CHECKPOINT_DEBOUNCE_MS gate.
    const d = makeDeps();
    const checkpoints: Array<{ fenceToken: string; headSeq: number }> = [];
    const stream = buildAgentSandboxUiStream({
      runId: "r",
      fenceToken: "f",
      chunks: harnessChunks(),
      streamBuffer: d.streamBuffer,
      title: d.title,
      hooks: {},
      checkpointPublisher: async (fenceToken, headSeq) => {
        checkpoints.push({ fenceToken, headSeq });
        return true;
      },
    });
    await drain(stream);

    // At least one checkpoint must have been published during the run.
    expect(checkpoints.length).toBeGreaterThan(0);
    // Every published checkpoint carries the correct fenceToken.
    expect(checkpoints.every((c) => c.fenceToken === "f")).toBe(true);
  });

  it("title passed to buildAgentSandboxUiStream should not have onTitleUpdated (call-site contract)", async () => {
    // The call site in prepareRun no longer wires onTitleUpdated. This test
    // confirms that buildAgentSandboxUiStream works correctly when the title
    // object has no onTitleUpdated — reflecting the projector-only sidebar-SSE
    // design. The stream must complete cleanly with no errors.
    const d = makeDeps();
    // Explicitly construct title WITHOUT onTitleUpdated — same shape as the
    // updated prepareRun call site.
    const titleWithoutOnTitleUpdated = {
      currentThreadTitle: null,
      threadId: "r",
      persistTitle: d.title.persistTitle,
      // onTitleUpdated intentionally absent
    };
    expect(
      (titleWithoutOnTitleUpdated as { onTitleUpdated?: unknown })
        .onTitleUpdated,
    ).toBeUndefined();

    const stream = buildAgentSandboxUiStream({
      runId: "r",
      fenceToken: "f",
      chunks: harnessChunks(),
      streamBuffer: d.streamBuffer,
      title: titleWithoutOnTitleUpdated,
      hooks: {},
    });
    await drain(stream);

    // All chunks published, done sentinel emitted — stream completed cleanly.
    expect(d.publishedRaw.map((p) => p.msgId)).toEqual([
      "r:f:1",
      "r:f:2",
      "r:f:3",
    ]);
    expect(d.publishedDone).toEqual([{ fenceToken: "f", finalSeq: 3 }]);
  });
});
