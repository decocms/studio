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
    // A stream_event with no `event` payload is still nothing to render — but a
    // populated one is NOT ignored any more; see the streaming tests below.
    expect(t.translate({ type: "stream_event" })).toEqual([]);
    expect(t.translate(assistant([{ type: "future_block" }]))).toEqual([]);
  });
});

/** One raw Anthropic streaming event, as the SDK forwards it. */
const streamEvent = (event: unknown) => ({
  type: "stream_event" as const,
  event,
});

describe("UiChunkTranslator — token streaming (includePartialMessages)", () => {
  test("a text block streams start/delta/end as the events arrive", () => {
    const t = new UiChunkTranslator();
    expect(t.translate(streamEvent({ type: "message_start" }))).toEqual([]);
    // The part opens on the first delta, not on the block start.
    const start = t.translate(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    expect(start).toEqual([]);
    expect(
      t.translate(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hel" },
        }),
      ),
    ).toEqual([
      { type: "text-start", id: "stream-1" },
      { type: "text-delta", id: "stream-1", delta: "Hel" },
    ]);
    expect(
      t.translate(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "lo" },
        }),
      ),
    ).toEqual([{ type: "text-delta", id: "stream-1", delta: "lo" }]);
    expect(
      t.translate(streamEvent({ type: "content_block_stop", index: 0 })),
    ).toEqual([{ type: "text-end", id: "stream-1" }]);
  });

  test("thinking streams as reasoning; signature deltas emit nothing", () => {
    const t = new UiChunkTranslator();
    t.translate(streamEvent({ type: "message_start" }));
    expect(
      t.translate(
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
      ),
    ).toEqual([]);
    expect(
      t.translate(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hmm" },
        }),
      ),
    ).toEqual([
      { type: "reasoning-start", id: "stream-1" },
      { type: "reasoning-delta", id: "stream-1", delta: "hmm" },
    ]);
    // Not renderable text — and it must not be appended to the reasoning part.
    expect(
      t.translate(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        }),
      ),
    ).toEqual([]);
  });

  test("the assistant message does not restate a block it already streamed", () => {
    const t = new UiChunkTranslator();
    t.translate(streamEvent({ type: "message_start" }));
    t.translate(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    t.translate(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }),
    );
    t.translate(streamEvent({ type: "content_block_stop", index: 0 }));
    // The SDK now restates the finished message. The text is already on the
    // wire; emitting it again is the duplication this guards.
    expect(t.translate(assistant([{ type: "text", text: "Hello" }]))).toEqual(
      [],
    );
  });

  test("a block still open at the step boundary is closed by the caller, once", () => {
    const t = new UiChunkTranslator();
    t.translate(streamEvent({ type: "message_start" }));
    t.translate(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
    );
    t.translate(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      }),
    );
    // No `content_block_stop`. The caller closes BEFORE it pushes
    // `finish-step` — the SDK reducer drops its open reasoning parts there, so
    // an end emitted after it is an orphan that throws and kills the run.
    expect(t.closeOpenStreamBlocks()).toEqual([
      { type: "reasoning-end", id: "stream-1" },
    ]);
    // The assistant restatement must not end it a second time.
    expect(
      t.translate(assistant([{ type: "thinking", thinking: "hmm" }])),
    ).toEqual([]);
  });

  test("tool calls still come from the assistant message, not the deltas", () => {
    const t = new UiChunkTranslator();
    t.translate(streamEvent({ type: "message_start" }));
    // A tool_use block streams its input as partial JSON — unusable, so the
    // start and the deltas yield nothing.
    expect(
      t.translate(
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "call-1", name: "Bash" },
        }),
      ),
    ).toEqual([]);
    expect(
      t.translate(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"cmd' },
        }),
      ),
    ).toEqual([]);
    // The complete input arrives with the assistant message, which is what
    // satisfies the tool-input-before-output contract.
    expect(
      t.translate(
        assistant([
          {
            type: "tool_use",
            id: "call-1",
            name: "Bash",
            input: { cmd: "ls" },
          },
        ]),
      ),
    ).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "Bash",
        input: { cmd: "ls" },
      },
    ]);
  });

  test("a streamed text block mixed with a tool call keeps both", () => {
    const t = new UiChunkTranslator();
    t.translate(streamEvent({ type: "message_start" }));
    t.translate(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    t.translate(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Running it" },
      }),
    );
    t.translate(streamEvent({ type: "content_block_stop", index: 0 }));
    // Index 0 was streamed, index 1 was not — only the tool call is restated.
    expect(
      t.translate(
        assistant([
          { type: "text", text: "Running it" },
          { type: "tool_use", id: "call-1", name: "Bash", input: {} },
        ]),
      ),
    ).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "Bash",
        input: {},
      },
    ]);
  });

  test("a block left open by an interrupted stream is closed, not leaked", () => {
    const t = new UiChunkTranslator();
    t.translate(streamEvent({ type: "message_start" }));
    t.translate(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    t.translate(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "half a sen" },
      }),
    );
    // No content_block_stop. The next message must close it, or the part is
    // reassembled as unfinished forever.
    expect(t.translate(streamEvent({ type: "message_start" }))).toEqual([
      { type: "text-end", id: "stream-1" },
    ]);
  });

  test("a second API message's indices are not skipped by the first's", () => {
    const t = new UiChunkTranslator();
    t.translate(streamEvent({ type: "message_start" }));
    t.translate(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    t.translate(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "first" },
      }),
    );
    t.translate(streamEvent({ type: "content_block_stop", index: 0 }));
    expect(t.translate(assistant([{ type: "text", text: "first" }]))).toEqual(
      [],
    );
    // An unstreamed new message still emits, though its block is at index 0 too.
    t.translate(streamEvent({ type: "message_start" }));
    expect(t.translate(assistant([{ type: "text", text: "second" }]))).toEqual([
      { type: "text-start", id: "u1-2" },
      { type: "text-delta", id: "u1-2", delta: "second" },
      { type: "text-end", id: "u1-2" },
    ]);
  });

  test("the text after a thinking block is streamed once, not twice", () => {
    // One `assistant` message per block: the text arrives at local index 0.
    const t = new UiChunkTranslator();
    t.translate(streamEvent({ type: "message_start" }));
    t.translate(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
    );
    t.translate(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "weighing it" },
      }),
    );
    t.translate(streamEvent({ type: "content_block_stop", index: 0 }));
    expect(
      t.translate(assistant([{ type: "thinking", thinking: "weighing it" }])),
    ).toEqual([]);
    t.translate(
      streamEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      }),
    );
    t.translate(
      streamEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "The answer." },
      }),
    );
    t.translate(streamEvent({ type: "content_block_stop", index: 1 }));
    expect(
      t.translate(assistant([{ type: "text", text: "The answer." }])),
    ).toEqual([]);
  });

  test("a thinking block that streamed no text is restated in full", () => {
    // This SDK sends only `signature_delta`, so the text is the message's alone.
    const t = new UiChunkTranslator();
    t.translate(streamEvent({ type: "message_start" }));
    expect(
      t.translate(
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
      ),
    ).toEqual([]);
    expect(
      t.translate(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        }),
      ),
    ).toEqual([]);
    expect(
      t.translate(streamEvent({ type: "content_block_stop", index: 0 })),
    ).toEqual([]);
    expect(
      t.translate(assistant([{ type: "thinking", thinking: "weighing it" }])),
    ).toEqual([
      { type: "reasoning-start", id: "u1-2" },
      { type: "reasoning-delta", id: "u1-2", delta: "weighing it" },
      { type: "reasoning-end", id: "u1-2" },
    ]);
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

  // `finishReason: "stop"` is load-bearing, not cosmetic: the live dispatch
  // path maps a MISSING reason to a FAILED thread (`resolveThreadStatus`), so
  // omitting it reported every clean turn as a failure.
  test("successful result finishes with stop and no error chunk", () => {
    expect(
      turnFinishChunks({
        type: "result",
        subtype: "success",
        is_error: false,
      }),
    ).toEqual([
      { type: "finish-step" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  test("usage and cost ride on the finish chunk", () => {
    const [, finish] = turnFinishChunks(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.42,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      },
      130,
    );
    expect((finish as { messageMetadata: unknown }).messageMetadata).toEqual({
      usage: {
        // The whole prompt, cache included — `input_tokens` alone is only the
        // uncached remainder, and consumers divide by this field.
        inputTokens: 130,
        outputTokens: 5,
        totalTokens: 135,
        contextTokens: 130,
        cachedInputTokens: 100,
        inputTokenDetails: {
          cacheReadTokens: 100,
          cacheWriteTokens: 20,
          noCacheTokens: 10,
        },
        providerMetadata: { openrouter: { usage: { cost: 0.42 } } },
      },
    });
  });

  // `result.usage` sums EVERY API call of the session, so deriving the context
  // size from it grew past the model's context window on a long turn
  // (1.7M/1M observed). Only the last call's prompt measures context fill.
  test("context size comes from the last request, not the session total", () => {
    const translator = new UiChunkTranslator();
    for (const cacheRead of [800_000, 812_565]) {
      translator.translate({
        type: "assistant",
        uuid: `u-${cacheRead}`,
        message: {
          content: [],
          usage: { input_tokens: 32, cache_read_input_tokens: cacheRead },
        },
      });
    }
    const [, finish] = turnFinishChunks(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 32,
          output_tokens: 6703,
          cache_read_input_tokens: 1_612_565,
          cache_creation_input_tokens: 116_355,
        },
      },
      translator.contextTokens,
    );
    const { usage } = (
      finish as { messageMetadata: { usage: { contextTokens: number } } }
    ).messageMetadata;
    expect(usage.contextTokens).toBe(812_597);
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
