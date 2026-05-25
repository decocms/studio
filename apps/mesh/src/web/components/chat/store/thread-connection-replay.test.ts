/**
 * Stream-replay invariant tests.
 *
 * Reproduces the "No tool invocation found for tool call ID X" error
 * users see when refreshing the browser mid-deep-research and the run
 * then completes. The error is thrown by the AI SDK's
 * `processUIMessageStream` (node_modules/ai/dist/index.mjs:5398) when
 * a `tool-output-available` chunk arrives without a matching
 * `tool-input-available` already in `state.message.parts`.
 *
 * We replay the exact chunk shape the server emits (captured from a
 * production SSE trace) through the same `readUIMessageStream` reader
 * the client uses in `thread-connection.ts:791`. Three scenarios:
 *
 *   1. Full sequence — sanity check that a complete stream folds
 *      cleanly when seeded with no prior message.
 *
 *   2. Refresh mid-poll, replay from start — the JetStream
 *      `deliverPolicy: "all"` happy path. All chunks since the run's
 *      first publish are present.
 *
 *   3. Refresh AT completion — the JetStream subject was purged when
 *      the run reached terminal state, so the reconnecting client
 *      only sees the live post-purge chunks (`tool-output-available`,
 *      `finish-step`, `finish`) without the preceding tool-input.
 *      This is what production hits.
 */

import { describe, expect, test } from "bun:test";
import { readUIMessageStream } from "ai";
import type { UIMessage, UIMessageChunk } from "ai";

const TOOL_CALL_ID = "tc_replay_test";
const MESSAGE_ID = "msg_replay_test";
const QUERY = "How does the new deep-research integration work?";
const REPORT = "The integration uses an async submit-then-poll protocol...";

/**
 * Build a chunk sequence shaped like what the AI SDK emits around a
 * `web_search` deep-research tool call. Mirrors the production SSE
 * trace structure (tool-input-* before data-web-search before
 * tool-output-available).
 */
function fullChunkSequence(): UIMessageChunk[] {
  return [
    { type: "start", messageId: MESSAGE_ID },
    { type: "start-step" },
    {
      type: "tool-input-start",
      toolCallId: TOOL_CALL_ID,
      toolName: "web_search",
    },
    {
      type: "tool-input-delta",
      toolCallId: TOOL_CALL_ID,
      inputTextDelta: JSON.stringify({ query: QUERY }),
    },
    {
      type: "tool-input-available",
      toolCallId: TOOL_CALL_ID,
      toolName: "web_search",
      input: { query: QUERY },
    },
    // Progress noise (empty during the early polling window).
    ...Array.from(
      { length: 5 },
      () =>
        ({
          type: "data-web-search",
          id: TOOL_CALL_ID,
          data: { text: "" },
        }) as UIMessageChunk,
    ),
    {
      type: "tool-output-available",
      toolCallId: TOOL_CALL_ID,
      output: { success: true, content: REPORT, query: QUERY },
    },
    { type: "finish-step" },
    { type: "finish" },
  ];
}

function streamOf(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function drain(
  iter: AsyncIterable<UIMessage>,
): Promise<{ messages: UIMessage[]; error: Error | null }> {
  const messages: UIMessage[] = [];
  let error: Error | null = null;
  try {
    for await (const msg of iter) messages.push(msg);
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  return { messages, error };
}

describe("UI message stream replay (web_search)", () => {
  test("full chunk sequence folds cleanly with no seed", async () => {
    const errors: unknown[] = [];
    const iter = readUIMessageStream({
      stream: streamOf(fullChunkSequence()),
      onError: (e) => errors.push(e),
    });

    const { messages, error } = await drain(iter);
    expect(error).toBeNull();
    expect(errors).toEqual([]);

    const final = messages.at(-1);
    expect(final).toBeDefined();
    const toolPart = final!.parts.find(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        "type" in p &&
        (p as { type: string }).type === "tool-web_search",
    );
    expect(toolPart).toBeDefined();
    expect((toolPart as { state: string }).state).toBe("output-available");
  });

  test("refresh mid-poll: full replay from start still folds cleanly", async () => {
    // Production scenario: user refreshes at minute 5 of a 15-minute
    // research run. JetStream's deliverPolicy:"all" replays every
    // chunk since publish-time-zero. Reader is seeded with `undefined`
    // because the DB has no in-progress assistant message yet
    // (onStepFinish doesn't fire until web_search returns).
    const errors: unknown[] = [];
    const iter = readUIMessageStream({
      // No seed — matches `foldSubStream` when the previous message
      // is the user's prompt.
      stream: streamOf(fullChunkSequence()),
      onError: (e) => errors.push(e),
    });

    const { messages, error } = await drain(iter);
    expect(error).toBeNull();
    expect(errors).toEqual([]);
    expect(messages.length).toBeGreaterThan(0);
  });

  test("refresh AT completion: tool-output without tool-input throws 'No tool invocation found'", async () => {
    // Production scenario: the server purges the JetStream subject
    // when the run reaches terminal state
    // (`stream-buffer.purge(taskId)`). If the client reconnects in
    // the narrow window between purge and the next state read, the
    // SSE replay returns ONLY the live post-purge chunks — the
    // tool-input-available chunk that preceded the purge is gone.
    //
    // This test asserts the failure mode so a future fix can flip
    // the expectation. The fix is to either:
    //   - guarantee an atomic purge + status-flip so the client never
    //     opens a stream against a purged-but-still-in_progress thread, OR
    //   - persist the tool-input part to the DB before purge, so the
    //     reader's seed already includes it.
    const postPurgeChunks: UIMessageChunk[] = [
      {
        type: "tool-output-available",
        toolCallId: TOOL_CALL_ID,
        output: { success: true, content: REPORT, query: QUERY },
      },
      { type: "finish-step" },
      { type: "finish" },
    ];

    const errors: unknown[] = [];
    const iter = readUIMessageStream({
      stream: streamOf(postPurgeChunks),
      onError: (e) => errors.push(e),
    });

    const { error } = await drain(iter);
    // The AI SDK surfaces this through onError rather than throwing
    // from the iterator (the iterator just stops). Either signal counts.
    const combined =
      error ??
      (errors[0] instanceof Error ? errors[0] : new Error(String(errors[0])));
    expect(combined).not.toBeNull();
    expect(String(combined?.message ?? "")).toContain(
      "No tool invocation found",
    );
    expect(String(combined?.message ?? "")).toContain(TOOL_CALL_ID);
  });

  test("reattach mid-research with stub seed: web_search completes and follow-up steps fold cleanly", async () => {
    // The customer scenario: proxy cuts SSE every ~2 minutes. On
    // reattach, the client refetches the DB (which now contains the
    // `msg_async_stub_<toolCallId>` row written at markPolling time)
    // and starts a fresh foldSubStream seeded with that stub. The
    // JetStream subject's 5-minute retention has aged out the original
    // `start` / `start-step` / `tool-input-*` chunks, so the new
    // SSE response begins with `data-web-search` and proceeds straight
    // to `tool-output-available` (web_search done), then a chain of
    // follow-up tool calls, then a text answer, then `finish`.
    //
    // Production symptom: the UI gets stuck on the web_search loading
    // skeleton even though the stream completes cleanly. A page
    // refresh fixes it (loadInitialPage replaces the stub with the
    // fully-populated assistant row).
    //
    // This test exercises the reader exactly as foldSubStream does:
    // seed = the persisted stub, no `start` chunk, the rest of the
    // run. If the final emitted message has the tool-web_search part
    // in `output-available` state plus the follow-up text, the SDK
    // reader path is fine and the bug lives in our wrapper (most
    // likely in how messages reconcile after refetch). If it doesn't,
    // we've reproduced the bug at the SDK layer.
    const STUB_ID = "msg_async_stub_" + TOOL_CALL_ID;
    const FOLLOWUP_TOOL_CALL_ID = "tc_followup_1";
    const FINAL_TEXT = "Aqui está o relatório final.";

    const stubSeed: UIMessage = {
      id: STUB_ID,
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: TOOL_CALL_ID,
          state: "input-available",
          input: { query: QUERY },
        },
      ],
    } as unknown as UIMessage;

    // Chunks the client sees on this reattach: no start, no start-step
    // for the web_search step (those aged out of JetStream). Mirrors
    // the production capture in
    // .context/attachments/.../pasted_text_2026-05-22_15-20-03.txt.
    const reattachChunks: UIMessageChunk[] = [
      // Late progress chunks (text now non-empty as the report streams in)
      {
        type: "data-web-search",
        id: TOOL_CALL_ID,
        data: { text: REPORT.slice(0, 30) },
      } as UIMessageChunk,
      {
        type: "data-web-search",
        id: TOOL_CALL_ID,
        data: { text: REPORT },
      } as UIMessageChunk,
      // web_search finishes
      {
        type: "data-tool-metadata",
        id: TOOL_CALL_ID,
        data: { latencyMs: 482_000 },
      } as UIMessageChunk,
      {
        type: "tool-output-available",
        toolCallId: TOOL_CALL_ID,
        output: { success: true, content: REPORT, query: QUERY },
      },
      { type: "finish-step" },
      { type: "message-metadata", messageMetadata: {} } as UIMessageChunk,
      // Next step in the agent loop — follow-up tool call
      { type: "start-step" },
      {
        type: "tool-input-start",
        toolCallId: FOLLOWUP_TOOL_CALL_ID,
        toolName: "DECO_SLIDES_CREATE",
      },
      {
        type: "tool-input-delta",
        toolCallId: FOLLOWUP_TOOL_CALL_ID,
        inputTextDelta: JSON.stringify({ title: "Relatório" }),
      },
      {
        type: "tool-input-available",
        toolCallId: FOLLOWUP_TOOL_CALL_ID,
        toolName: "DECO_SLIDES_CREATE",
        input: { title: "Relatório" },
      },
      {
        type: "tool-output-available",
        toolCallId: FOLLOWUP_TOOL_CALL_ID,
        output: { id: "slides_1" },
      },
      { type: "finish-step" },
      { type: "message-metadata", messageMetadata: {} } as UIMessageChunk,
      // Final synthesis step — text deltas
      { type: "start-step" },
      { type: "text-start", id: "txt_1" } as UIMessageChunk,
      {
        type: "text-delta",
        id: "txt_1",
        delta: FINAL_TEXT,
      } as UIMessageChunk,
      { type: "text-end", id: "txt_1" } as UIMessageChunk,
      { type: "finish-step" },
      { type: "message-metadata", messageMetadata: {} } as UIMessageChunk,
      { type: "finish" },
    ];

    const errors: unknown[] = [];
    const iter = readUIMessageStream({
      message: stubSeed,
      stream: streamOf(reattachChunks),
      onError: (e) => errors.push(e),
    });

    const { messages, error } = await drain(iter);
    expect(error).toBeNull();
    expect(errors).toEqual([]);

    const final = messages.at(-1);
    expect(final).toBeDefined();
    // Should keep the stub's id (we seeded with it, and no `start`
    // chunk arrived to rewrite it).
    expect(final!.id).toBe(STUB_ID);

    // The web_search tool part must have transitioned to output-available.
    const webSearchPart = final!.parts.find(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        "type" in p &&
        (p as { type: string }).type === "tool-web_search",
    ) as { state: string; output?: { content?: string } } | undefined;
    expect(webSearchPart).toBeDefined();
    expect(webSearchPart!.state).toBe("output-available");
    expect(webSearchPart!.output?.content).toBe(REPORT);

    // The follow-up tool call should be present and finished too.
    const followupPart = final!.parts.find(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        "type" in p &&
        (p as { type: string }).type === "tool-DECO_SLIDES_CREATE",
    ) as { state: string } | undefined;
    expect(followupPart).toBeDefined();
    expect(followupPart!.state).toBe("output-available");

    // And the final synthesis text must have streamed in.
    const textPart = final!.parts.find(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        "type" in p &&
        (p as { type: string }).type === "text",
    ) as { text: string } | undefined;
    expect(textPart).toBeDefined();
    expect(textPart!.text).toContain(FINAL_TEXT);
  });

  test("refresh AT completion with seed-from-DB containing tool-input recovers", async () => {
    // The fix-path: if we persist the tool-input-available part to
    // the DB when the row goes to 'polling', the client's
    // `loadInitialPage` returns a seed message that already has the
    // tool part. The reader then folds the post-purge stream into
    // that seed and the lookup in `getToolInvocation` succeeds.
    const seedFromDb: UIMessage = {
      id: MESSAGE_ID,
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: TOOL_CALL_ID,
          state: "input-available",
          input: { query: QUERY },
        },
      ],
    } as unknown as UIMessage;

    const postPurgeChunks: UIMessageChunk[] = [
      {
        type: "tool-output-available",
        toolCallId: TOOL_CALL_ID,
        output: { success: true, content: REPORT, query: QUERY },
      },
      { type: "finish-step" },
      { type: "finish" },
    ];

    const errors: unknown[] = [];
    const iter = readUIMessageStream({
      message: seedFromDb,
      stream: streamOf(postPurgeChunks),
      onError: (e) => errors.push(e),
    });

    const { messages, error } = await drain(iter);
    expect(error).toBeNull();
    expect(errors).toEqual([]);

    const final = messages.at(-1);
    expect(final).toBeDefined();
    const toolPart = final!.parts.find(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        "type" in p &&
        (p as { type: string }).type === "tool-web_search",
    );
    expect(toolPart).toBeDefined();
    expect((toolPart as { state: string }).state).toBe("output-available");
  });
});
