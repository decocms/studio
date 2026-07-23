/**
 * Tool-invocation invariant guard.
 *
 * The AI SDK's `readUIMessageStream` throws
 * `No tool invocation found for tool call ID "X"` when a `tool-output-available`
 * / `tool-output-error` / `tool-input-delta` chunk references a tool call whose
 * `tool-input-*` part is neither in the seed message nor earlier in the stream.
 *
 * That invariant breaks whenever a run is reconstructed after abnormal
 * termination — the owning pod is SIGTERM'd mid-step (ghost run force-fail),
 * the JetStream subject is purged mid-window, or a retention gap drops the
 * input seq — so a tool's output survives but its input does not. The whole
 * chat then bricks on reload.
 *
 * The guard sits between the chunk source and the reader: it tracks which tool
 * call ids already have an invocation (seeded from the message's existing
 * parts, then updated as `tool-input-*` chunks flow through) and synthesizes a
 * minimal `tool-input-available` before any orphaned reference. The tool then
 * renders as a completed call with an unknown name instead of aborting the run.
 */

import type { UIMessage, UIMessageChunk } from "ai";

/** Chunk types that create a tool invocation the reader can look up later. */
const CREATES_INVOCATION = new Set([
  "tool-input-start",
  "tool-input-available",
]);

/** Chunk types that require a pre-existing invocation and throw without one. */
const REQUIRES_INVOCATION = new Set([
  "tool-input-delta",
  "tool-output-available",
  "tool-output-error",
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
 * the chunk(s) to forward — either the input unchanged, or a synthetic
 * `tool-input-available` followed by the orphaned chunk.
 */
export function createToolInvariantGuard(
  seedToolCallIds: Iterable<string> = [],
): (chunk: UIMessageChunk) => UIMessageChunk[] {
  const known = new Set(seedToolCallIds);

  return (chunk) => {
    const { type } = chunk;
    const toolCallId = (chunk as { toolCallId?: unknown }).toolCallId;

    if (typeof toolCallId !== "string") return [chunk];

    if (CREATES_INVOCATION.has(type)) {
      known.add(toolCallId);
      return [chunk];
    }

    if (REQUIRES_INVOCATION.has(type) && !known.has(toolCallId)) {
      known.add(toolCallId);
      const synthetic = {
        type: "tool-input-available",
        toolCallId,
        toolName:
          (chunk as { toolName?: unknown }).toolName ?? UNKNOWN_TOOL_NAME,
        input: {},
      } as UIMessageChunk;
      return [synthetic, chunk];
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
