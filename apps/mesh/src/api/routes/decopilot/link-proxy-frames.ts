/**
 * NDJSON wire framing for the Phase C-bis pull reverse-proxy channel.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FRAMING SPEC (S2 — the daemon side — MUST match this exactly)
 * ───────────────────────────────────────────────────────────────────────────
 * Both legs are NDJSON: ONE JSON value per line, lines delimited by a single
 * `\n`. No `\n\n` blocks, no `data: ` SSE prefix. A line is the JSON text of a
 * frame; a trailing newline is optional on the final line.
 *
 * REQUEST leg (cluster → daemon), subject `links.proxy.req.<userSub>`:
 *   Exactly one `RequestFrame` per published NATS message (NOT a stream). It is
 *   the same envelope the daemon's in-process control handler already consumes
 *   (`link-control-types.ts` `RequestFrame`): `{ type:"request", reqId, method,
 *   path, headers, body? }`. The `reqId` correlates the reply leg.
 *
 * REPLY leg (daemon → cluster), POST body of
 *   `POST /api/:org/links/proxy/:reqId/stream` as a `duplex:"half"` upload:
 *   A STREAM of NDJSON `ProxyReplyFrame` lines, consumed frame-by-frame WITHOUT
 *   buffering and each republished to `links.proxy.reply.<reqId>`. Ordering:
 *     1. AT MOST ONE `headers` frame, FIRST (before any `chunk`). The awaiting
 *        `DispatchFn` surfaces it as `{ headers }`; `runner.ts` depends on it
 *        arriving before body bytes.
 *     2. ZERO OR MORE `chunk` frames. `chunk.data` is BASE64 (landmine #9 —
 *        base64 end-to-end so binary vm-tools file reads are safe; base64 has
 *        no embedded `\n`, so line-delimiting is safe). The daemon MUST
 *        base64-encode the raw upstream bytes (NOT TextDecoder UTF-8, which the
 *        WS path used). The cluster decodes via `DispatchChunk.data` consumers.
 *     3. EXACTLY ONE terminal frame to close the stream: `end` (clean) or
 *        `error` (`{ type:"error", code, message }`). The awaiting `DispatchFn`
 *        returns on `end` and throws on `error`.
 *
 * CANCEL leg: a `{ type:"cancel_req", reqId }` CONTROL frame published by the
 * cluster adapter on caller abort to `links.control.<userSub>` — the EXISTING
 * control channel the outbound-only daemon already long-polls (it cannot
 * subscribe to a dedicated per-reqId cancel subject). The daemon's control-poll
 * (S2) forwards the reqId to its reqId→AbortController registry, which aborts
 * `handleStream` and frees the `/events` SSE slot.
 * ───────────────────────────────────────────────────────────────────────────
 */
import { z } from "zod";

/**
 * Reply-leg frame union for the pull reverse-proxy channel. The per-frame
 * `reqId` is carried in the NATS subject / URL, not repeated in every line.
 */
const headersReplyFrame = z.object({
  type: z.literal("headers"),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
});

const chunkReplyFrame = z.object({
  type: z.literal("chunk"),
  /** BASE64-encoded upstream bytes (landmine #9). */
  data: z.string(),
});

const endReplyFrame = z.object({
  type: z.literal("end"),
});

const errorReplyFrame = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string(),
});

export const proxyReplyFrameSchema = z.discriminatedUnion("type", [
  headersReplyFrame,
  chunkReplyFrame,
  endReplyFrame,
  errorReplyFrame,
]);

export type ProxyReplyFrame = z.infer<typeof proxyReplyFrameSchema>;

const KNOWN_REPLY_TYPES = new Set(
  proxyReplyFrameSchema.options.map(
    (opt) => (opt as { shape: { type: { value: string } } }).shape.type.value,
  ),
);

export function encodeProxyReplyFrame(frame: ProxyReplyFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse a single NDJSON line into a `ProxyReplyFrame`. Throws on malformed
 * JSON or an unknown/invalid frame so the caller can surface an error frame to
 * the awaiter rather than silently dropping a line.
 */
export function decodeProxyReplyFrame(line: string): ProxyReplyFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("link-proxy-frames: malformed JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("link-proxy-frames: frame must be an object");
  }
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string" || !KNOWN_REPLY_TYPES.has(type)) {
    throw new Error(`link-proxy-frames: unknown frame type "${String(type)}"`);
  }
  const parsed = proxyReplyFrameSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`link-proxy-frames: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Streaming NDJSON line splitter. Consumes a byte stream WITHOUT buffering the
 * whole body — mirrors `parse-dispatch-sse.ts` but delimits on a single `\n`.
 * Yields one trimmed (non-empty) line at a time as soon as it is complete.
 *
 * A single multi-byte UTF-8 char may split across reads, so a single streaming
 * TextDecoder is used. The pending buffer only ever holds the current
 * incomplete line, never the whole stream.
 */
export async function* splitNdjsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const trimmed = line.trim();
        if (trimmed.length > 0) yield trimmed;
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}
