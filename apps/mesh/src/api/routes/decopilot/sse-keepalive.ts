/**
 * SSE keepalive wrapper.
 *
 * Wraps a streaming Response so the body interleaves `: keepalive\n\n` SSE
 * comment lines on a fixed interval. Per the SSE spec (and confirmed in the
 * `eventsource-parser` package the AI SDK uses), lines starting with `:` are
 * comments and are silently ignored by the parser — so injecting them is
 * transparent to the client.
 *
 * Why this exists: the AI SDK's `JsonToSseTransformStream` only emits bytes
 * when there's a real chunk to send. During long tool calls or deep-research
 * polling phases the stream can be byte-silent for tens of seconds, which
 * trips the read timeouts of common reverse proxies (nginx ingress 60s,
 * Istio 15s, ALB 60s). Heartbeats keep the socket warm.
 *
 * Defensive design (this is critical-path streaming code):
 *
 *  - Heartbeats are ONLY injected on event boundaries (chunk ending `\n\n`).
 *    Mid-event injection would corrupt the JSON payload of a `data:` line,
 *    so a partial-tail chunk suppresses the next heartbeat until the next
 *    chunk completes the event. Today the AI SDK enqueues one full event per
 *    chunk so this is moot, but the boundary check guards against future
 *    chunk-fragmentation upstream.
 *
 *  - The interval is cleared on stream end, source error, and downstream
 *    cancel — anything else would leak a Node timer per request.
 *
 *  - `controller.enqueue` is wrapped in try/catch so a closed-controller race
 *    can't surface as an unhandled exception.
 *
 *  - Downstream cancel (client closed connection) is forwarded to the source
 *    so the relay/JetStream chain unwinds correctly.
 *
 *  - The wrapper never originates errors; source errors propagate unchanged.
 */

const KEEPALIVE_BYTES = new TextEncoder().encode(": keepalive\n\n");
const LF = 0x0a;
const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Wrap an SSE response body with periodic keepalive comments.
 *
 * Returns a new Response with the same status/statusText/headers but a body
 * stream that intersperses `: keepalive\n\n` every `intervalMs` between real
 * chunks. If `response.body` is null (already-consumed or empty response),
 * the original response is returned unchanged.
 */
export function wrapWithSseKeepalive(
  response: Response,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Response {
  if (!response.body) return response;

  const wrapped = wrapStreamWithKeepalive(response.body, intervalMs);

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Lower-level: wrap a `ReadableStream<Uint8Array>` of SSE bytes with
 * periodic keepalive comments. Exposed separately so tests can drive it
 * without going through Response/fetch plumbing.
 */
export function wrapStreamWithKeepalive(
  source: ReadableStream<Uint8Array>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): ReadableStream<Uint8Array> {
  // These vars are captured by both `start` and `cancel`. They live across
  // the constructor's two method scopes so cancel can reach the active reader.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let cleaned = false;
  // Tracks whether the most recent chunk left the byte stream mid-event (no
  // trailing `\n\n`). When true, heartbeats are suppressed until the next
  // chunk completes the event boundary.
  let pendingPartial = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = source.getReader();

      const tryHeartbeat = () => {
        if (cleaned || pendingPartial) return;
        try {
          controller.enqueue(KEEPALIVE_BYTES);
        } catch {
          // Controller already closed — let the read loop's teardown handle
          // the rest. Mark cleaned so subsequent ticks no-op.
          cleaned = true;
          clearTimer();
        }
      };

      timer = setInterval(tryHeartbeat, intervalMs);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            cleaned = true;
            clearTimer();
            controller.close();
            return;
          }

          // Decide whether the next heartbeat tick is allowed to fire by
          // checking if this chunk ends on an SSE event boundary (`\n\n`).
          // Empty chunks (zero-length) inherit the previous boundary state.
          const len = value.byteLength;
          if (len > 0) {
            pendingPartial = !(
              len >= 2 &&
              value[len - 2] === LF &&
              value[len - 1] === LF
            );
          }

          controller.enqueue(value);
        }
      } catch (err) {
        cleaned = true;
        clearTimer();
        try {
          controller.error(err);
        } catch {
          // Already errored/closed — nothing to do.
        }
      } finally {
        cleaned = true;
        clearTimer();
        try {
          reader.releaseLock();
        } catch {
          // Lock may already be released (e.g. cancel path); releaseLock
          // throws on an unlocked reader.
        }
      }
    },
    cancel(reason) {
      // Downstream cancelled (e.g. client disconnected). Cancel via the
      // active reader (which holds the lock) so propagation reaches the
      // source's cancel hook. Falls back to the source if no reader yet.
      cleaned = true;
      clearTimer();
      const cancelTarget = reader ?? source;
      cancelTarget.cancel(reason).catch(() => {
        // Cancel may reject if already errored — best-effort.
      });
    },
  });
}
