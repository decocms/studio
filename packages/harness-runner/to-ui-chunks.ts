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
 * Deliberately NOT streaming (v1): the caller buffers a whole turn and flushes
 * on `result`, so every text block arrives as start+delta+end back to back.
 * The chunk vocabulary is identical either way, so switching to incremental
 * emission later is a change of *when* these are yielded, not *what*.
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
  message: { id?: string; content: unknown[] };
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
  /** Anthropic-shaped token counts for the whole turn. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** The CLI's own cost estimate for the turn, in USD. */
  total_cost_usd?: number;
}

export type TranslatableSdkMessage =
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkResultMessage
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
    return [];
  }

  private nextBlockId(uuid: string): string {
    this.blockSeq += 1;
    return `${uuid}-${this.blockSeq}`;
  }

  private translateAssistant(message: SdkAssistantMessage): UIMessageChunk[] {
    const chunks: UIMessageChunk[] = [];
    for (const block of message.message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
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
export function turnFinishChunks(result: SdkResultMessage): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [];
  if (result.is_error) {
    chunks.push({
      type: "error",
      errorText: result.result ?? `claude-code run failed (${result.subtype})`,
    });
  }
  chunks.push({ type: "finish-step" });
  const usage = turnUsage(result);
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
 * One turn is one step here, so cumulative and per-step totals coincide. The
 * cost is the CLI's own estimate — it is reported under `openrouter` because
 * that is the only slot the UI reads a dollar figure from, and this harness
 * bills through OpenRouter; it is not OpenRouter's own accounting.
 */
function turnUsage(result: SdkResultMessage): Record<string, unknown> | null {
  const usage = result.usage;
  if (!usage) return null;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cost = result.total_cost_usd ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    cachedInputTokens: cacheReadTokens,
    inputTokenDetails: {
      cacheReadTokens,
      cacheWriteTokens,
      noCacheTokens: inputTokens,
    },
    ...(cost > 0
      ? { providerMetadata: { openrouter: { usage: { cost } } } }
      : {}),
  };
}
