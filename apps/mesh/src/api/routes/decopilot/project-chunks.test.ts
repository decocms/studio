import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import { makeTitleResultChunk } from "@decocms/harness/title-chunk";
import { DEFAULT_THREAD_TITLE } from "./constants";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import { projectChunks } from "./project-chunks";

function helloChunks(): AsyncIterable<UIMessageChunk> {
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

/** A turn whose stream carries an auto-generated title-result chunk. */
function helloChunksWithTitle(title: string): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    yield { type: "start" } as UIMessageChunk;
    yield makeTitleResultChunk(title) as unknown as UIMessageChunk;
    yield { type: "text-start", id: "txt" } as UIMessageChunk;
    yield { type: "text-delta", id: "txt", delta: "hello" } as UIMessageChunk;
    yield { type: "text-end", id: "txt" } as UIMessageChunk;
    yield { type: "finish", finishReason: "stop" } as UIMessageChunk;
  })();
}

function recordingPersistence() {
  const finals: Array<{ id: string; parts?: unknown[] }> = [];
  const errors: Array<[string, string]> = [];
  const persistence: HarnessStreamPersistence = {
    emitStepParts: async () => {},
    emitFinal: async (m) => {
      finals.push(m);
    },
    emitError: async (id, text) => {
      errors.push([id, text]);
    },
  };
  return { finals, errors, persistence };
}

describe("projectChunks", () => {
  test("reassembles raw chunks and persists the final assistant message", async () => {
    const { finals, persistence } = recordingPersistence();
    await projectChunks({ chunks: helloChunks(), persistence });
    expect(finals).toHaveLength(1);
    const text = (finals[0]!.parts ?? []).find(
      (p) => (p as { type?: string }).type === "text",
    ) as { text?: string } | undefined;
    expect(text?.text).toBe("hello");
  });

  test("a thrown source surfaces via emitError and rethrows", async () => {
    const { errors, persistence } = recordingPersistence();
    const boom = (async function* () {
      yield { type: "start" } as UIMessageChunk;
      throw new Error("provider exploded");
    })();
    await expect(projectChunks({ chunks: boom, persistence })).rejects.toThrow(
      "provider exploded",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toBe("provider exploded");
  });

  test("persists the auto-title when the thread title is still the default", async () => {
    const { persistence } = recordingPersistence();
    const persisted: Array<{ threadId: string; title: string }> = [];
    await projectChunks({
      chunks: helloChunksWithTitle("Generated Title"),
      persistence,
      title: {
        threadId: "run_1",
        currentThreadTitle: DEFAULT_THREAD_TITLE,
        persistTitle: async (threadId, title) => {
          persisted.push({ threadId, title });
        },
      },
    });
    expect(persisted).toEqual([
      { threadId: "run_1", title: "Generated Title" },
    ]);
  });

  test("does NOT overwrite a user-renamed (non-default) thread title", async () => {
    const { persistence } = recordingPersistence();
    const persisted: Array<{ threadId: string; title: string }> = [];
    await projectChunks({
      chunks: helloChunksWithTitle("Auto Title Should Not Apply"),
      persistence,
      title: {
        threadId: "run_1",
        currentThreadTitle: "User Renamed Me",
        persistTitle: async (threadId, title) => {
          persisted.push({ threadId, title });
        },
      },
    });
    // The gate is closed (current title != default) — the auto-title is dropped.
    expect(persisted).toEqual([]);
  });

  test("a persistence failure (emitFinal throws) surfaces so the projector can retry", async () => {
    // The durable DB-writer's contract is "persist or fail loudly".
    // consumeHarnessStream swallows persistence errors (logs them) so the live
    // UI path survives a DB hiccup; the projector must NOT — a swallowed write
    // would silently lose a part. projectChunks re-throws it so projectRun can
    // retry/DLQ.
    const persistence: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {
        throw new Error("db write failed");
      },
      emitError: async () => {},
    };
    await expect(
      projectChunks({ chunks: helloChunks(), persistence }),
    ).rejects.toThrow("db write failed");
  });
});
