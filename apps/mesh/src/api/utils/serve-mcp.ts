/**
 * Per-request MCP server lifecycle.
 *
 * Routes that serve MCP over HTTP build a fresh `McpServer` + transport per
 * request (stateless mode). The SDK does not tear these down on its own: each
 * registered tool handler closes over the server (and the request's
 * StudioContext), so a server that is never `close()`d stays reachable
 * forever. In production this leaked thousands of fully-populated servers
 * (~4.6k in a 5-minute heap snapshot — every tool's Zod schemas + handler
 * closures + the captured ctx), filling the heap until GC pegged the CPU and
 * the pod was OOMKilled.
 *
 * `serveMcpRequest` is the one place that gets this right: handle the
 * request, stream the body through the guard, and close the server (which
 * closes its transport) exactly once — after the body is fully delivered,
 * on client cancel, on client disconnect (request abort), or on a handler
 * throw.
 */
import { guardResponseStream } from "./stream-guard";

interface CloseableServer {
  close(): Promise<void>;
}

interface RequestTransport {
  handleRequest(req: Request): Promise<Response>;
}

interface ServeMcpOptions {
  /**
   * Extra teardown to run exactly once when the response is done, alongside
   * `server.close()`. Closing the server cascades into its own transport only;
   * a bridge server delegates to a client via request handlers and does NOT
   * close it. For a **per-request, non-pooled** client (e.g. the
   * PassthroughClient a virtual-MCP route builds fresh) pass
   * `() => client.close()` here, or the client + its downstream
   * connections/transports leak.
   */
  onClose?: () => void | Promise<void>;
}

export async function serveMcpRequest(
  server: CloseableServer,
  transport: RequestTransport,
  request: Request,
  label: string,
  options?: ServeMcpOptions,
): Promise<Response> {
  const signal = request.signal;

  // Idempotent: the abort listener and the stream guard's onDone can both fire
  // (e.g. disconnect racing body-complete) — teardown must run exactly once.
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", close);
    void server.close().catch((err) => {
      console.error(`[serve-mcp] ${label} server close failed:`, err);
    });
    if (options?.onClose) {
      void Promise.resolve()
        .then(options.onClose)
        .catch((err) => {
          console.error(`[serve-mcp] ${label} onClose failed:`, err);
        });
    }
  };

  // Backstop for the SSE-pinning leak: a long-lived MCP stream keeps the
  // per-request server (its tool Zod graph + transport) alive via the guard's
  // suspended read loop. On client disconnect the runtime may stop reading
  // WITHOUT cancelling the stream, so the guard's onDone never fires. The
  // request's AbortSignal does fire on disconnect — close on it too.
  if (signal && !signal.aborted) {
    signal.addEventListener("abort", close, { once: true });
  }

  let response: Response;
  try {
    response = await transport.handleRequest(request);
  } catch (err) {
    close();
    throw err;
  }
  return guardResponseStream(response, label, close);
}
