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
  it("publishes seq-keyed raw chunks via ingestRun, fires hooks once, never persists inline title", async () => {
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
    // Projector is the sole DB writer — the inline persistTitle is a NO-OP.
    expect(d.persistedTitles).toEqual([]);
    expect(finishCount).toBe(1);
    // Authoritative {done} marker fires once, fence-scoped to the last seq.
    expect(d.publishedDone).toEqual([{ fenceToken: "f", finalSeq: 3 }]);
  });
});
