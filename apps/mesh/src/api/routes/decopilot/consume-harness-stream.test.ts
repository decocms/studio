import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import { makeTitleResultChunk } from "@decocms/harness/title-chunk";
import { consumeHarnessStream } from "./consume-harness-stream";

async function drain(stream: ReadableStream) {
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

function chunkStream(chunks: unknown[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function textChunks(): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    yield { type: "start" } as UIMessageChunk;
    yield { type: "text-start", id: "txt" } as UIMessageChunk;
    yield { type: "text-delta", id: "txt", delta: "hello" } as UIMessageChunk;
    yield { type: "text-end", id: "txt" } as UIMessageChunk;
    yield {
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    } as UIMessageChunk;
  })();
}

function textChunksWithUsage(): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    yield { type: "start" } as UIMessageChunk;
    yield {
      type: "message-metadata",
      messageMetadata: {
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    } as UIMessageChunk;
    yield { type: "text-start", id: "txt" } as UIMessageChunk;
    yield { type: "text-delta", id: "txt", delta: "hello" } as UIMessageChunk;
    yield { type: "text-end", id: "txt" } as UIMessageChunk;
    yield {
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    } as UIMessageChunk;
  })();
}

function textChunksWithRichUsage(): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    yield { type: "start" } as UIMessageChunk;
    yield {
      type: "message-metadata",
      messageMetadata: {
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 7,
          cacheWriteTokens: 2,
          costUsd: 0.0123,
        },
      },
    } as UIMessageChunk;
    yield { type: "text-start", id: "txt" } as UIMessageChunk;
    yield { type: "text-delta", id: "txt", delta: "hello" } as UIMessageChunk;
    yield { type: "text-end", id: "txt" } as UIMessageChunk;
    yield {
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as UIMessageChunk;
  })();
}

describe("consumeHarnessStream", () => {
  test("accepts a ReadableStream of UIMessageChunks directly", async () => {
    const finals: unknown[] = [];
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunkStream: chunkStream([
        { type: "start" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "hi" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop" },
      ]),
      title: {
        currentThreadTitle: "New chat",
        threadId: "thread_1",
        persistTitle: async () => {},
      },
      persistence: {
        emitStepParts: async () => {},
        emitFinal: async (message) => {
          finals.push(message);
        },
        emitError: async () => {},
      },
    });

    await drain(uiStream);
    await whenComplete;

    expect(finals).toHaveLength(1);
  });
  test("persists final assistant message after consuming chunks", async () => {
    const finals: Array<{ id: string; parts?: unknown[] }> = [];
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks: textChunks(),
      originalMessages: [],
      title: {
        currentThreadTitle: "Existing title",
        threadId: "thread-1",
        persistTitle: async () => {
          throw new Error("title should not persist");
        },
      },
      persistence: {
        emitFinal: async (message) => {
          finals.push(message);
        },
        emitStepParts: async () => {},
        emitError: async () => {},
      },
      hooks: {},
    });

    await drain(uiStream);
    await whenComplete;

    expect(finals).toHaveLength(1);
    expect(finals[0]!.parts?.length).toBeGreaterThan(0);
  });

  test("intercepts title result, persists title, and does not expose title chunk", async () => {
    const persisted: Array<[string, string]> = [];
    const exposed: UIMessageChunk[] = [];
    const chunks = (async function* () {
      yield makeTitleResultChunk("Generated title") as UIMessageChunk;
      yield* textChunks();
    })();

    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks,
      originalMessages: [],
      title: {
        currentThreadTitle: "New chat",
        threadId: "thread-1",
        persistTitle: async (threadId, title) => {
          persisted.push([threadId, title]);
        },
      },
      persistence: {
        emitFinal: async () => {},
        emitStepParts: async () => {},
        emitError: async () => {},
      },
      hooks: {},
    });

    const reader = uiStream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        exposed.push(value as UIMessageChunk);
      }
    } finally {
      reader.releaseLock();
    }
    await whenComplete;

    expect(persisted).toEqual([["thread-1", "Generated title"]]);
    expect(exposed.some((chunk) => chunk.type === "data-title-result")).toBe(
      false,
    );
  });

  test("reports final usage from response message metadata", async () => {
    const usage: unknown[] = [];
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks: textChunksWithUsage(),
      originalMessages: [],
      title: {
        currentThreadTitle: "Existing title",
        threadId: "thread-1",
        persistTitle: async () => {},
      },
      persistence: {
        emitFinal: async () => {},
        emitStepParts: async () => {},
        emitError: async () => {},
      },
      hooks: {
        onUsage: (totals) => {
          usage.push(totals);
        },
      },
    });

    await drain(uiStream);
    await whenComplete;

    expect(usage).toEqual([
      { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    ]);
  });

  test("extracts rich usage (cache + cost passthrough) from final metadata", async () => {
    let seen: Record<string, unknown> | null = null;
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks: textChunksWithRichUsage(),
      originalMessages: [],
      title: {
        currentThreadTitle: "Existing title",
        threadId: "thread-1",
        persistTitle: async () => {},
      },
      persistence: {
        emitFinal: async () => {},
        emitStepParts: async () => {},
        emitError: async () => {},
      },
      hooks: {
        onUsage: (totals) => {
          seen = totals as Record<string, unknown>;
        },
      },
    });

    await drain(uiStream);
    await whenComplete;

    expect(seen).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      costUsd: 0.0123,
    });
  });

  test("passes finishReason to the onFinish hook", async () => {
    let reason: string | undefined;
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks: textChunks(),
      originalMessages: [],
      title: {
        currentThreadTitle: "Existing title",
        threadId: "thread-1",
        persistTitle: async () => {},
      },
      persistence: {
        emitFinal: async () => {},
        emitStepParts: async () => {},
        emitError: async () => {},
      },
      hooks: {
        onFinish: (_message, finishReason) => {
          reason = finishReason;
        },
      },
    });

    await drain(uiStream);
    await whenComplete;

    expect(reason).toBe("stop");
  });

  test("delivers usage to onUsage before the onFinish hook", async () => {
    const order: string[] = [];
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks: textChunksWithUsage(),
      originalMessages: [],
      title: {
        currentThreadTitle: "Existing title",
        threadId: "thread-1",
        persistTitle: async () => {},
      },
      persistence: {
        emitFinal: async () => {},
        emitStepParts: async () => {},
        emitError: async () => {},
      },
      hooks: {
        onUsage: () => {
          order.push("usage");
        },
        onFinish: () => {
          order.push("finish");
        },
      },
    });

    await drain(uiStream);
    await whenComplete;

    expect(order).toEqual(["usage", "finish"]);
  });

  test("ignores non-object usage metadata (array)", async () => {
    const usage: unknown[] = [];
    const chunks = (async function* () {
      yield { type: "start" } as UIMessageChunk;
      yield {
        type: "message-metadata",
        messageMetadata: { usage: [10, 5, 15] },
      } as UIMessageChunk;
      yield { type: "text-start", id: "txt" } as UIMessageChunk;
      yield { type: "text-delta", id: "txt", delta: "hello" } as UIMessageChunk;
      yield { type: "text-end", id: "txt" } as UIMessageChunk;
      yield { type: "finish", finishReason: "stop" } as UIMessageChunk;
    })();

    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks,
      originalMessages: [],
      title: {
        currentThreadTitle: "Existing title",
        threadId: "thread-1",
        persistTitle: async () => {},
      },
      persistence: {
        emitFinal: async () => {},
        emitStepParts: async () => {},
        emitError: async () => {},
      },
      hooks: {
        onUsage: (totals) => {
          usage.push(totals);
        },
      },
    });

    await drain(uiStream);
    await whenComplete;

    expect(usage).toEqual([]);
  });

  test("sanitizeErrorText shapes the wire error chunk; emitError keeps raw text", async () => {
    const emitted: string[] = [];
    const exposed: UIMessageChunk[] = [];
    const chunks = (async function* () {
      yield { type: "start" } as UIMessageChunk;
      throw new Error("raw provider failure");
    })();

    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks,
      originalMessages: [],
      title: {
        currentThreadTitle: "Existing title",
        threadId: "thread-1",
        persistTitle: async () => {},
      },
      persistence: {
        emitFinal: async () => {},
        emitStepParts: async () => {},
        emitError: async (_messageId, errorText) => {
          emitted.push(errorText);
        },
      },
      sanitizeErrorText: (error) =>
        `[SANITIZED] ${error instanceof Error ? error.message : String(error)}`,
    });

    const reader = uiStream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        exposed.push(value as UIMessageChunk);
      }
    } finally {
      reader.releaseLock();
    }
    await whenComplete;

    const errorChunk = exposed.find((c) => c.type === "error") as
      | { type: "error"; errorText: string }
      | undefined;
    expect(errorChunk?.errorText).toBe("[SANITIZED] raw provider failure");
    expect(emitted).toEqual(["raw provider failure"]);
  });

  function captureFinalIds(): {
    ids: string[];
    persistence: {
      emitStepParts: (m: { id: string }) => Promise<void>;
      emitFinal: (m: { id: string }) => Promise<void>;
      emitError: () => Promise<void>;
    };
  } {
    const ids: string[] = [];
    return {
      ids,
      persistence: {
        emitStepParts: async () => {},
        emitFinal: async (m) => {
          ids.push(m.id);
        },
        emitError: async () => {},
      },
    };
  }

  const TITLE = {
    currentThreadTitle: "New chat",
    threadId: "thread_1",
    persistTitle: async () => {},
  };

  function harnessChunks(messageId: string): AsyncIterable<UIMessageChunk> {
    return (async function* () {
      yield { type: "start", messageId } as UIMessageChunk;
      yield { type: "text-start", id: "t" } as UIMessageChunk;
      yield { type: "text-delta", id: "t", delta: "hi" } as UIMessageChunk;
      yield { type: "text-end", id: "t" } as UIMessageChunk;
      yield { type: "finish", finishReason: "stop" } as UIMessageChunk;
    })();
  }

  test("preserves the harness start.messageId when no generateMessageId", async () => {
    const { ids, persistence } = captureFinalIds();
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks: harnessChunks("msg_harness_1"),
      title: TITLE,
      persistence,
    });
    await drain(uiStream);
    await whenComplete;
    expect(ids).toEqual(["msg_harness_1"]);
  });

  test("continuation: first message adopts the trailing assistant id", async () => {
    const { ids, persistence } = captureFinalIds();
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks: harnessChunks("msg_continuation_2"),
      originalMessages: [
        { id: "msg_user_0", role: "user", parts: [] },
        { id: "msg_proposal_1", role: "assistant", parts: [] },
      ] as never,
      title: TITLE,
      persistence,
    });
    await drain(uiStream);
    await whenComplete;
    expect(ids).toEqual(["msg_proposal_1"]);
    expect(ids).not.toContain("msg_continuation_2");
  });

  test("fresh turn (trailing user message): keeps the harness id", async () => {
    const { ids, persistence } = captureFinalIds();
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks: harnessChunks("msg_harness_3"),
      originalMessages: [
        { id: "msg_user_0", role: "user", parts: [] },
      ] as never,
      title: TITLE,
      persistence,
    });
    await drain(uiStream);
    await whenComplete;
    expect(ids).toEqual(["msg_harness_3"]);
  });

  test("generateMessageId still remaps deterministically (background-tool path)", async () => {
    const { ids, persistence } = captureFinalIds();
    let n = 0;
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks: harnessChunks("msg_harness_ignored"),
      title: TITLE,
      persistence,
      generateMessageId: () => `job_1:msg:${n++}`,
    });
    await drain(uiStream);
    await whenComplete;
    expect(ids).toEqual(["job_1:msg:0"]);
  });

  test("uses the provided errorMessageId so the error message is stable across retries", async () => {
    const seenIds: string[] = [];
    // Two independent consumptions of the same erroring run (e.g. a projector
    // retry or a daemon resend). With a run-derived id the synthesized error
    // message lands at the SAME id both times → ON CONFLICT dedupes it.
    for (let i = 0; i < 2; i++) {
      const { uiStream, whenComplete } = consumeHarnessStream({
        chunks: (async function* () {
          yield { type: "start" } as UIMessageChunk;
          throw new Error("boom");
        })(),
        originalMessages: [],
        title: {
          currentThreadTitle: "t",
          threadId: "run-1",
          persistTitle: async () => {},
        },
        errorMessageId: "error-run-1",
        persistence: {
          emitFinal: async () => {},
          emitStepParts: async () => {},
          emitError: async (messageId) => {
            seenIds.push(messageId);
          },
        },
      });
      await drain(uiStream);
      await whenComplete;
    }

    expect(seenIds).toEqual(["error-run-1", "error-run-1"]);
  });
});
