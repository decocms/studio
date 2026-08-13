/**
 * Tool-invocation invariant guard.
 *
 * A tail that starts mid-run (subject purged, retention gap, pod SIGTERM'd
 * mid-step) delivers a tool's deltas or output without its `tool-input-start`.
 * `readUIMessageStream` then throws and the whole chat bricks:
 *   - `No tool invocation found for tool call ID "X"` — output chunk with no
 *     tool part (from the seed message or an earlier `tool-input-*`).
 *   - `Received tool-input-delta for missing tool call with ID "X"` — delta with
 *     no `partialToolCalls` entry, which ONLY `tool-input-start` creates.
 *
 * So: synthesize a `tool-input-available` before an orphan output (renders as a
 * completed call named "unknown"), and drop an orphan delta — deltas carry no
 * `toolName` and the closing `tool-input-available` carries the full input, so
 * dropping the partial prefix costs one streaming animation.
 */

import type { UIMessage, UIMessageChunk } from "ai";

/** Chunk types that create the tool *part* an output chunk looks up. */
const CREATES_PART = new Set(["tool-input-start", "tool-input-available"]);

/** Chunk types that require a pre-existing part and throw without one. */
const REQUIRES_PART = new Set([
  "tool-output-available",
  "tool-output-error",
  "tool-approval-request",
  "tool-output-denied",
]);

/** Placeholder name for a tool whose input part was lost. */
const UNKNOWN_TOOL_NAME = "unknown";

/** Collect every `toolCallId` already present on a seed message's parts. */
export function toolCallIdsInMessage(msg: UIMessage | undefined): string[] {
  const ids: string[] = [];
  for (const part of msg?.parts ?? []) {
    const id = (part as { toolCallId?: unknown }).toolCallId;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/**
 * Build a stateful guard. Call it once per chunk in stream order; it returns
 * the chunk(s) to forward — the chunk unchanged, a synthetic
 * `tool-input-available` followed by an orphan output, or nothing (orphan
 * delta).
 */
export function createToolInvariantGuard(
  seedToolCallIds: Iterable<string> = [],
): (chunk: UIMessageChunk) => UIMessageChunk[] {
  /** Ids with a tool part (seeded, or created by a `tool-input-*` chunk). */
  const withPart = new Set(seedToolCallIds);
  /** Ids the reader has a `partialToolCalls` entry for — `tool-input-start` only. */
  const started = new Set<string>();

  return (chunk) => {
    const { type } = chunk;
    const toolCallId = (chunk as { toolCallId?: unknown }).toolCallId;

    if (typeof toolCallId !== "string") return [chunk];

    if (CREATES_PART.has(type)) {
      withPart.add(toolCallId);
      if (type === "tool-input-start") started.add(toolCallId);
      return [chunk];
    }

    if (type === "tool-input-delta") {
      return started.has(toolCallId) ? [chunk] : [];
    }

    if (REQUIRES_PART.has(type) && !withPart.has(toolCallId)) {
      withPart.add(toolCallId);
      return [
        {
          type: "tool-input-available",
          toolCallId,
          toolName:
            (chunk as { toolName?: unknown }).toolName ?? UNKNOWN_TOOL_NAME,
          input: {},
        } as UIMessageChunk,
        chunk,
      ];
    }

    return [chunk];
  };
}

/**
 * Wrap a chunk stream so the tool-invocation invariant always holds before the
 * chunks reach `readUIMessageStream`. `seed` is the message the reader folds
 * into (its existing tool parts count as already-known invocations).
 */
export function guardToolInvariant(
  stream: ReadableStream<UIMessageChunk>,
  seed: UIMessage | undefined,
): ReadableStream<UIMessageChunk> {
  const guard = createToolInvariantGuard(toolCallIdsInMessage(seed));
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        for (const out of guard(chunk)) controller.enqueue(out);
      },
    }),
  );
}
