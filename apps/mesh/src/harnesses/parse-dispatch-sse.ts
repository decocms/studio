/**
 * Parse a `/dispatch` SSE response body.
 *
 * The wire format (emitted by the sandbox daemon's `/dispatch` route) is a
 * sequence of `\n\n`-delimited event blocks, each with one or more `data: `
 * lines whose joined JSON matches `dispatchSSEEventSchema`. Consumed by the
 * daemon chunk relay (`link-daemon/chunk-relay.ts`), which forwards every raw
 * `DispatchSSEEvent` to the cluster verbatim.
 *
 * `parseDispatchSSEEvents` yields every validated raw `DispatchSSEEvent`
 * (ui-message-chunk / error / done). Malformed frames are skipped silently.
 */
import {
  type DispatchSSEEvent,
  dispatchSSEEventSchema,
} from "../links/protocol";

/** Decode one `\n\n`-delimited SSE block; null for malformed frames. */
function decodeEventBlock(eventText: string): DispatchSSEEvent | null {
  const dataLines = eventText
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length));
  if (dataLines.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  const ev = dispatchSSEEventSchema.safeParse(parsed);
  return ev.success ? ev.data : null;
}

/**
 * Yield every validated raw `DispatchSSEEvent` from the SSE body, including
 * `error` and `done` events. Malformed frames are skipped.
 *
 * `opts.signal` aborts the parse: the underlying reader is cancelled (which
 * settles a pending `read()` with `{done: true}` and runs the source's cancel
 * hook — verified on Bun 1.3.14, where this is the only way to interrupt a
 * read blocked on a quiet-but-open stream) and the generator rejects with the
 * signal's reason.
 */
export async function* parseDispatchSSEEvents(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<DispatchSSEEvent, void, undefined> {
  const { signal } = opts;
  const reader = body.getReader();
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
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
        const event = decodeEventBlock(block);
        if (event) yield event;
        sep = buffer.indexOf("\n\n");
      }
    }
    // A cancelled reader reports `{done: true}` like a graceful end — surface
    // the abort instead of treating the stream as complete.
    signal?.throwIfAborted();
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > 0) {
      const event = decodeEventBlock(tail);
      if (event) yield event;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
