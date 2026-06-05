/**
 * Parse a `/dispatch` SSE response body into a stream of UIMessageChunk.
 *
 * The wire format (emitted by the sandbox daemon's `/dispatch` route) is a
 * sequence of `\n\n`-delimited event blocks, each with one or more `data: `
 * lines whose joined JSON matches `dispatchSSEEventSchema`. Shared by
 * `remoteDispatch` (cluster pulls the daemon) and the link ingest endpoint
 * (desktop pushes the cluster) so both decode identically.
 */
import type { UIMessageChunk } from "ai";
import { dispatchSSEEventSchema } from "../links/protocol";

function* emitEvent(eventText: string): Generator<UIMessageChunk> {
  const dataLines = eventText
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length));
  if (dataLines.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  const ev = dispatchSSEEventSchema.safeParse(parsed);
  if (!ev.success) return;
  if (ev.data.type === "ui-message-chunk") {
    yield ev.data.chunk as UIMessageChunk;
  } else if (ev.data.type === "error") {
    throw new Error(`[parseDispatchSSE] ${ev.data.code}: ${ev.data.message}`);
  }
  // `done` yields no chunk — the iterable ends when the body closes.
}

export async function* parseDispatchSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<UIMessageChunk> {
  const reader = body.getReader();
  // SINGLE streaming decoder — a multi-byte UTF-8 char can split across reads.
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        yield* emitEvent(block);
        sep = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > 0) yield* emitEvent(tail);
  } finally {
    reader.releaseLock();
  }
}
