import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { withModelMetadata } from "./with-model-metadata";

const chunk = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as UIMessageChunk;

async function collect(
  source: AsyncIterable<UIMessageChunk>,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const c of source) out.push(c as Record<string, unknown>);
  return out;
}

function stream(...types: string[]): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    for (const t of types) yield chunk(t);
  })();
}

describe("withModelMetadata", () => {
  test("stamps the model immediately after start, and nowhere else", async () => {
    const out = await collect(
      withModelMetadata(
        stream("start", "text-start", "text-end", "finish"),
        "anthropic/claude-opus-5",
        "deco",
      ),
    );
    expect(out.map((c) => c.type)).toEqual([
      "start",
      "message-metadata",
      "text-start",
      "text-end",
      "finish",
    ]);
    expect(out[1]?.messageMetadata).toEqual({
      models: {
        thinking: {
          id: "anthropic/claude-opus-5",
          title: "anthropic/claude-opus-5",
          provider: "deco",
        },
      },
    });
  });

  test("stamps once even when a continuation replays start", async () => {
    const out = await collect(
      withModelMetadata(
        stream("start", "text-start", "start", "finish"),
        "claude-sonnet-5",
        "anthropic",
      ),
    );
    expect(out.filter((c) => c.type === "message-metadata")).toHaveLength(1);
  });

  test("passes every chunk through untouched", async () => {
    const source = (async function* () {
      yield chunk("start");
      yield chunk("text-delta", { id: "t", delta: "hi" });
      yield chunk("finish", { finishReason: "stop" });
    })();
    const out = await collect(withModelMetadata(source, "m", "p"));
    expect(out.filter((c) => c.type !== "message-metadata")).toEqual([
      { type: "start" },
      { type: "text-delta", id: "t", delta: "hi" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  test("stamps nothing when the model is unknown", async () => {
    for (const modelId of [null, undefined, ""]) {
      const out = await collect(
        withModelMetadata(stream("start", "finish"), modelId, "deco"),
      );
      expect(out.map((c) => c.type)).toEqual(["start", "finish"]);
    }
  });

  test("a stream that never starts is passed through as-is", async () => {
    const out = await collect(
      withModelMetadata(stream("error"), "claude-opus-5", "anthropic"),
    );
    expect(out.map((c) => c.type)).toEqual(["error"]);
  });
});
