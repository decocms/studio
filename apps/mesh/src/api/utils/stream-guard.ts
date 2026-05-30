/**
 * Wraps a streaming Response so a mid-flight error in the body's ReadableStream
 * results in a clean close instead of an abrupt abort.
 *
 * Without this guard, when the underlying source throws after the Response has
 * already been returned to Hono (e.g. an MCP bridge call to an upstream tool
 * fails during a `tools/list` aggregation), the stream propagates the error and
 * the connection drops mid-body — Cloudflare interprets that as a malformed
 * origin response and serves the client a generic 520 instead of letting the
 * client see the truncated stream and retry.
 *
 * The guard catches the error, logs it for the operator, and closes the
 * controller cleanly. The client receives a well-formed but truncated SSE
 * response and can recover via its own retry/reconnect logic.
 */
export function guardResponseStream(
  response: Response,
  label: string,
): Response {
  if (!response.body) return response;

  const source = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const guarded = new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          controller.enqueue(value);
        }
      } catch (err) {
        console.error(`[stream-guard] ${label} stream errored:`, err);
      } finally {
        try {
          controller.close();
        } catch {
          // controller may already be closed (e.g. via downstream cancel)
        }
      }
    },
    async cancel(reason) {
      // The source has a reader locked from start(); cancelling via the reader
      // both releases the lock and propagates the cancel reason upstream.
      if (reader) {
        await reader.cancel(reason).catch(() => {});
      } else {
        await source.cancel(reason).catch(() => {});
      }
    },
  });

  return new Response(guarded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
