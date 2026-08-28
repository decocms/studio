/**
 * Claude Agent SDK message stream → AI SDK `UIMessageChunk` stream.
 *
 * Studio's whole consume side — `consumeHarnessStream`, `ingestRun`, the
 * durable projector, `thread_message_parts`, the chat UI — speaks
 * `UIMessageChunk` and nothing else. Translating here means the Claude Code
 * harness needs no new storage shape, no new part types and no UI work: it
 * looks exactly like a Decopilot run from the moment it leaves this file.
 *
 * Two contracts to respect, both learned from the projector:
 *  - a `tool-output-available` MUST be preceded by the matching
 *    `tool-input-available` (same `toolCallId`), or part reassembly throws on
 *    reconnect (`apps/api/src/storage/ports.ts`).
 *  - text/reasoning ids are per-block, not per-message: two text blocks in one
 *    assistant turn are two parts.
 *
 * Token-granular when the SDK streams, block-granular when it does not. With
 * `includePartialMessages` on (see `claude-code.ts`) text and thinking arrive as
 * `stream_event` deltas and are emitted as they land; the `assistant` message
 * that follows then re-states those same blocks, so the indices already
 * streamed are skipped there rather than emitted twice. Tool calls are always
 * taken from the `assistant` message: `input_json_delta` is partial JSON, and
 * the ordering contract above needs a COMPLETE input before the output.
 */

import type { UIMessageChunk } from "ai";

/**
 * The subset of the SDK's message union this translator reads. Narrowed
 * structurally rather than imported: these arrive as JSON over a subprocess
 * pipe, and a discriminant check is what makes a shape change a compile error
 * here instead of a silent runtime drop.
 */
export interface SdkAssistantMessage {
  type: "assistant";
  uuid: string;
  /** Content blocks are `unknown`: every field read below is guarded, so an
   *  SDK block shape this translator has not met yet is skipped, not crashed
   *  on. */
  message: {
    id?: string;
    content: unknown[];
    /** Per-API-call token counts. Unlike `result.usage` (cumulative over the
     *  whole session) this is the one request the model just served, which is
     *  the only thing that measures context fill. */
    usage?: SdkUsage;
  };
}

interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface SdkUserMessage {
  type: "user";
  uuid?: string;
  message: { content: unknown[] | string };
}

export interface SdkResultMessage {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  /** Anthropic-shaped token counts, summed over every API call of the session
   *  — NOT one request. Fine for cost/in/out; useless as a context size. */
  usage?: SdkUsage;
  /** The CLI's own cost estimate for the turn, in USD. */
  total_cost_usd?: number;
}

/**
 * A raw Anthropic streaming event, forwarded by the SDK under
 * `includePartialMessages`. Only the content-block events matter here; `event`
 * is `unknown` because every field read off it is guarded.
 */
export interface SdkStreamEventMessage {
  type: "stream_event";
  event: unknown;
}

export type TranslatableSdkMessage =
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkResultMessage
  | SdkStreamEventMessage
  | { type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Flatten a `tool_result` content payload to something the UI can render.
 * The SDK hands back either a string or Anthropic content blocks; anything
 * else is passed through untouched so a future block type is preserved in the
 * stored part rather than stringified into noise.
 */
export function flattenToolResult(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  // Only collapse when every block was text — otherwise the caller loses
  // images//documents, which is worse than a slightly richer stored value.
  return texts.length === content.length ? texts.join("\n") : content;
}

/**
 * Translates one turn. Stateful only in the ids it mints, so a caller can feed
 * messages as they arrive and collect chunks, then flush once on `result`.
 */
export class UiChunkTranslator {
  /** tool_use ids seen this turn — guards the ordering contract above. */
  private readonly announcedToolCalls = new Set<string>();
  private blockSeq = 0;
  /**
   * Text/reasoning blocks opened from `stream_event` and not yet closed, keyed
   * by the Anthropic content-block index. Holds the minted chunk id so the
   * deltas and the end land on the part the start opened.
   */
  private readonly openStreamBlocks = new Map<
    number,
    { id: string; kind: "text" | "reasoning" }
  >();
  /**
   * Content-block indices of the message currently streaming that were already
   * emitted as deltas. The `assistant` message restates every block, so these
   * are skipped there — the same index is positional in both, which is what
   * makes the skip safe.
   */
  private readonly streamedIndices = new Set<number>();
  /**
   * Prompt tokens of the most recent API call — how full the model's context
   * actually was. Read by `turnFinishChunks`; `result.usage` cannot supply it
   * because it sums every call of the session (a long turn's cached prompts
   * stack up past the context window).
   */
  contextTokens = 0;

  /**
   * Chunks for one SDK message, in emission order. Unknown message types and
   * unknown content blocks yield nothing: this harness must not fail a run
   * because the SDK grew a message kind Studio does not render yet.
   */
  translate(message: TranslatableSdkMessage): UIMessageChunk[] {
    if (message.type === "assistant" && "message" in message) {
      return this.translateAssistant(message as SdkAssistantMessage);
    }
    if (message.type === "user" && "message" in message) {
      return this.translateToolResults(message as SdkUserMessage);
    }
    if (message.type === "stream_event" && "event" in message) {
      return this.translateStreamEvent(
        (message as SdkStreamEventMessage).event,
      );
    }
    return [];
  }

  /**
   * One raw Anthropic streaming event → chunks. Text and thinking deltas are
   * forwarded as they arrive; everything else (tool input deltas, message
   * envelopes, signatures) yields nothing, because the `assistant` message is
   * the authority for those.
   */
  private translateStreamEvent(event: unknown): UIMessageChunk[] {
    if (!isRecord(event)) return [];
    // A new message: nothing from the previous one may still be open, and its
    // skip set does not apply to this one's indices.
    if (event.type === "message_start") {
      const chunks = this.closeOpenStreamBlocks();
      this.streamedIndices.clear();
      return chunks;
    }
    const index = event.index;
    if (typeof index !== "number") return [];
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (!isRecord(block)) return [];
      const kind =
        block.type === "text"
          ? ("text" as const)
          : block.type === "thinking"
            ? ("reasoning" as const)
            : null;
      // tool_use blocks are announced from the `assistant` message instead.
      if (!kind) return [];
      const id = this.nextBlockId("stream");
      this.openStreamBlocks.set(index, { id, kind });
      this.streamedIndices.add(index);
      return [{ type: `${kind}-start`, id } as UIMessageChunk];
    }
    if (event.type === "content_block_delta") {
      const open = this.openStreamBlocks.get(index);
      const delta = event.delta;
      if (!open || !isRecord(delta)) return [];
      const text =
        open.kind === "text" && typeof delta.text === "string"
          ? delta.text
          : open.kind === "reasoning" && typeof delta.thinking === "string"
            ? delta.thinking
            : null;
      // `signature_delta` on a thinking block, `input_json_delta` on a tool
      // call: both arrive here and neither is renderable text.
      if (text === null || text.length === 0) return [];
      return [
        {
          type: `${open.kind}-delta`,
          id: open.id,
          delta: text,
        } as UIMessageChunk,
      ];
    }
    if (event.type === "content_block_stop") {
      const open = this.openStreamBlocks.get(index);
      if (!open) return [];
      this.openStreamBlocks.delete(index);
      return [{ type: `${open.kind}-end`, id: open.id } as UIMessageChunk];
    }
    return [];
  }

  /**
   * End every block still open from `stream_event`. A stream that stops without
   * `content_block_stop` (an interrupt, a crash mid-block) would otherwise
   * leave a part that never closes, which the projector reassembles as
   * unfinished forever.
   *
   * Public because a `-end` must never cross a `finish-step`: the AI SDK's
   * reducer CLEARS its open text/reasoning parts on that boundary, so a late
   * end lands on a part it no longer knows and throws `Received reasoning-end
   * for missing reasoning part`, killing the run mid-stream. The caller closes
   * here before it opens a new step (see `claude-code.ts`).
   */
  closeOpenStreamBlocks(): UIMessageChunk[] {
    if (this.openStreamBlocks.size === 0) return [];
    const chunks: UIMessageChunk[] = [];
    for (const open of this.openStreamBlocks.values()) {
      chunks.push({ type: `${open.kind}-end`, id: open.id } as UIMessageChunk);
    }
    this.openStreamBlocks.clear();
    return chunks;
  }

  private nextBlockId(uuid: string): string {
    this.blockSeq += 1;
    return `${uuid}-${this.blockSeq}`;
  }

  private translateAssistant(message: SdkAssistantMessage): UIMessageChunk[] {
    const usage = message.message.usage;
    if (usage) {
      this.contextTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
    }
    // Anything the stream left open belongs to this message and must close
    // before its blocks are restated.
    const chunks: UIMessageChunk[] = this.closeOpenStreamBlocks();
    for (const [index, block] of message.message.content.entries()) {
      if (!isRecord(block)) continue;
      // Already emitted as deltas — restating it here would duplicate the text.
      const streamed = this.streamedIndices.has(index);
      if (block.type === "text" && typeof block.text === "string") {
        if (streamed) continue;
        // Empty text blocks are real in the SDK stream (a turn that only made
        // a tool call). Emitting start/end for them would create empty parts.
        if (block.text.length === 0) continue;
        const id = this.nextBlockId(message.uuid);
        chunks.push({ type: "text-start", id });
        chunks.push({ type: "text-delta", id, delta: block.text });
        chunks.push({ type: "text-end", id });
        continue;
      }
      if (block.type === "thinking" && typeof block.thinking === "string") {
        if (streamed) continue;
        if (block.thinking.length === 0) continue;
        const id = this.nextBlockId(message.uuid);
        chunks.push({ type: "reasoning-start", id });
        chunks.push({ type: "reasoning-delta", id, delta: block.thinking });
        chunks.push({ type: "reasoning-end", id });
        continue;
      }
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        this.announcedToolCalls.add(block.id);
        chunks.push({
          type: "tool-input-available",
          toolCallId: block.id,
          toolName: block.name,
          input: block.input ?? {},
        });
      }
    }
    // This message is fully accounted for; the next one's indices are its own.
    this.streamedIndices.clear();
    return chunks;
  }

  private translateToolResults(message: SdkUserMessage): UIMessageChunk[] {
    const content = message.message.content;
    if (!Array.isArray(content)) return [];
    const chunks: UIMessageChunk[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type !== "tool_result") continue;
      const toolCallId = block.tool_use_id;
      if (typeof toolCallId !== "string") continue;
      // Ordering contract: a result whose call we never announced would make
      // the projector's part reassembly throw. Dropping it loses one tool
      // panel; letting it through fails the whole run.
      if (!this.announcedToolCalls.has(toolCallId)) continue;
      if (block.is_error === true) {
        const flattened = flattenToolResult(block.content);
        chunks.push({
          type: "tool-output-error",
          toolCallId,
          errorText:
            typeof flattened === "string"
              ? flattened
              : JSON.stringify(flattened),
        });
        continue;
      }
      chunks.push({
        type: "tool-output-available",
        toolCallId,
        output: flattenToolResult(block.content),
      });
    }
    return chunks;
  }
}

/** Opening chunks for a turn. `messageId` keys the assistant message Studio stores. */
export function turnStartChunks(messageId: string): UIMessageChunk[] {
  return [{ type: "start", messageId }, { type: "start-step" }];
}

/**
 * Closing chunks for a turn. An SDK `result` with `is_error` becomes an
 * `error` chunk *before* `finish` so the run is recorded as failed rather than
 * silently succeeding with no output.
 *
 * `finishReason` is ALWAYS set — `"stop"` on a clean turn. It is not optional
 * decoration: the live dispatch path resolves the thread's terminal status with
 * `resolveThreadStatus(finishReason, …)`, which maps `undefined` to **failed**
 * (only the durable projector special-cases a missing reason as completed). A
 * turn that opened its PR and then reported `failed` is exactly what omitting it
 * produced.
 */
export function turnFinishChunks(
  result: SdkResultMessage,
  contextTokens = 0,
): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [];
  if (result.is_error) {
    chunks.push({
      type: "error",
      errorText: result.result ?? `claude-code run failed (${result.subtype})`,
    });
  }
  chunks.push({ type: "finish-step" });
  const usage = turnUsage(result, contextTokens);
  chunks.push({
    type: "finish",
    finishReason: result.is_error ? ("error" as const) : ("stop" as const),
    ...(usage ? { messageMetadata: { usage } } : {}),
  });
  return chunks;
}

/**
 * The turn's usage in the `messageMetadata.usage` shape Studio stores and the
 * chat UI reads (`apps/api/src/harnesses/lib/usage-accumulator.ts`).
 *
 * `result.usage` is cumulative over the turn's API calls, which is what the
 * in/out/cache totals want. `contextTokens` is the exception — it must be the
 * LAST call's prompt size (the UI divides it by the context window), so it
 * comes from the translator, not from here.
 *
 * The cost is the CLI's own estimate — it is reported under `openrouter`
 * because that is the only slot the UI reads a dollar figure from, and this
 * harness bills through OpenRouter; it is not OpenRouter's own accounting.
 */
function turnUsage(
  result: SdkResultMessage,
  contextTokens: number,
): Record<string, unknown> | null {
  const usage = result.usage;
  if (!usage) return null;
  const noCacheTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  // Anthropic bills the cached portions as their own counters, so
  // `input_tokens` is only the uncached remainder. `inputTokens` in Studio's
  // shape is the WHOLE prompt (`usage-accumulator` derives `noCacheTokens` by
  // subtracting cache from it) — report it that way or every consumer that
  // divides by it is off by the cache.
  const inputTokens = noCacheTokens + cacheReadTokens + cacheWriteTokens;
  const cost = result.total_cost_usd ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    contextTokens,
    cachedInputTokens: cacheReadTokens,
    inputTokenDetails: {
      cacheReadTokens,
      cacheWriteTokens,
      noCacheTokens,
    },
    ...(cost > 0
      ? { providerMetadata: { openrouter: { usage: { cost } } } }
      : {}),
  };
}
