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
 * on client cancel, or on a handler throw.
 */
import { guardResponseStream } from "./stream-guard";

interface CloseableServer {
  close(): Promise<void>;
}

interface RequestTransport {
  handleRequest(req: Request): Promise<Response>;
}

export async function serveMcpRequest(
  server: CloseableServer,
  transport: RequestTransport,
  request: Request,
  label: string,
): Promise<Response> {
  // Closing the server cascades into its own transport only — bridge servers
  // delegate to their client via request handlers, so a shared/pooled client
  // is never closed from here.
  const close = () => {
    void server.close().catch((err) => {
      console.error(`[serve-mcp] ${label} server close failed:`, err);
    });
  };

  let response: Response;
  try {
    response = await transport.handleRequest(request);
  } catch (err) {
    close();
    throw err;
  }
  return guardResponseStream(response, label, close);
}
