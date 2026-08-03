import { describe, expect, test } from "bun:test";
import {
  flattenToolResult,
  turnFinishChunks,
  turnStartChunks,
  UiChunkTranslator,
} from "./to-ui-chunks";

function assistant(content: unknown[], uuid = "u1") {
  return { type: "assistant" as const, uuid, message: { content } };
}

describe("UiChunkTranslator", () => {
  test("text block becomes start/delta/end with a stable id", () => {
    const chunks = new UiChunkTranslator().translate(
      assistant([{ type: "text", text: "hello" }]),
    );
    expect(chunks).toEqual([
      { type: "text-start", id: "u1-1" },
      { type: "text-delta", id: "u1-1", delta: "hello" },
      { type: "text-end", id: "u1-1" },
    ]);
  });

  test("two text blocks in one message get distinct ids", () => {
    const chunks = new UiChunkTranslator().translate(
      assistant([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    );
    const ids = chunks
      .filter((c) => c.type === "text-start")
      .map((c) => ("id" in c ? c.id : null));
    expect(ids).toEqual(["u1-1", "u1-2"]);
  });

  test("empty text and thinking blocks emit nothing", () => {
    const chunks = new UiChunkTranslator().translate(
      assistant([
        { type: "text", text: "" },
        { type: "thinking", thinking: "" },
      ]),
    );
    expect(chunks).toEqual([]);
  });

  test("thinking block maps onto reasoning parts", () => {
    const chunks = new UiChunkTranslator().translate(
      assistant([{ type: "thinking", thinking: "hmm" }]),
    );
    expect(chunks.map((c) => c.type)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
    ]);
  });

  test("tool_use becomes tool-input-available", () => {
    const chunks = new UiChunkTranslator().translate(
      assistant([
        { type: "tool_use", id: "t1", name: "Read", input: { file: "a.ts" } },
      ]),
    );
    expect(chunks).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "t1",
        toolName: "Read",
        input: { file: "a.ts" },
      },
    ]);
  });

  test("tool_use with no input still yields an object input", () => {
    const chunks = new UiChunkTranslator().translate(
      assistant([{ type: "tool_use", id: "t1", name: "Bash" }]),
    );
    expect(chunks[0]).toMatchObject({ input: {} });
  });

  test("tool_result after its call becomes tool-output-available", () => {
    const t = new UiChunkTranslator();
    t.translate(assistant([{ type: "tool_use", id: "t1", name: "Read" }]));
    const chunks = t.translate({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "body" }],
      },
    });
    expect(chunks).toEqual([
      { type: "tool-output-available", toolCallId: "t1", output: "body" },
    ]);
  });

  test("is_error tool_result becomes tool-output-error", () => {
    const t = new UiChunkTranslator();
    t.translate(assistant([{ type: "tool_use", id: "t1", name: "Read" }]));
    const chunks = t.translate({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "boom",
            is_error: true,
          },
        ],
      },
    });
    expect(chunks).toEqual([
      { type: "tool-output-error", toolCallId: "t1", errorText: "boom" },
    ]);
  });

  test("orphan tool_result is dropped, not emitted", () => {
    // The projector throws when an output has no matching input part, so an
    // unannounced result must never reach the stream.
    const chunks = new UiChunkTranslator().translate({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }],
      },
    });
    expect(chunks).toEqual([]);
  });

  test("string user content (a plain prompt echo) emits nothing", () => {
    const chunks = new UiChunkTranslator().translate({
      type: "user",
      message: { content: "just text" },
    });
    expect(chunks).toEqual([]);
  });

  test("unknown message types and blocks are ignored", () => {
    const t = new UiChunkTranslator();
    expect(t.translate({ type: "system" })).toEqual([]);
    expect(t.translate({ type: "stream_event" })).toEqual([]);
    expect(t.translate(assistant([{ type: "future_block" }]))).toEqual([]);
  });
});

describe("flattenToolResult", () => {
  test("passes strings through", () => {
    expect(flattenToolResult("x")).toBe("x");
  });

  test("joins all-text blocks", () => {
    expect(
      flattenToolResult([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });

  test("keeps mixed content intact so images are not lost", () => {
    const mixed = [
      { type: "text", text: "a" },
      { type: "image", source: {} },
    ];
    expect(flattenToolResult(mixed)).toBe(mixed);
  });

  test("passes non-array non-string values through", () => {
    expect(flattenToolResult({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("turn framing", () => {
  test("start chunks carry the message id", () => {
    expect(turnStartChunks("msg_1")).toEqual([
      { type: "start", messageId: "msg_1" },
      { type: "start-step" },
    ]);
  });

  test("successful result finishes without an error chunk", () => {
    expect(
      turnFinishChunks({
        type: "result",
        subtype: "success",
        is_error: false,
      }),
    ).toEqual([{ type: "finish-step" }, { type: "finish" }]);
  });

  test("failed result emits error before finish", () => {
    const chunks = turnFinishChunks({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "exploded",
    });
    expect(chunks).toEqual([
      { type: "error", errorText: "exploded" },
      { type: "finish-step" },
      { type: "finish", finishReason: "error" },
    ]);
  });

  test("failed result with no message still explains itself", () => {
    const chunks = turnFinishChunks({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
    });
    expect(chunks[0]).toEqual({
      type: "error",
      errorText: "claude-code run failed (error_max_turns)",
    });
  });
});
