import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
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
});
