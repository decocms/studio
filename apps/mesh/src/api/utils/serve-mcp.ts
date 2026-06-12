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
import { meter } from "../../observability";
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

/**
 * Leak gauge for per-request MCP servers. `built` counts servers entering
 * `serveMcpRequest`, `closed` counts completed teardowns, `collected` counts
 * servers the GC actually reclaimed (via FinalizationRegistry). A rising
 * `built - collected` floor under steady traffic means servers are being
 * pinned after close — the production leak signature — and tells us so
 * without needing a heap snapshot.
 */
const gauge = {
  built: 0,
  closed: 0,
  collected: 0,
};
const collectedRegistry = new FinalizationRegistry<null>(() => {
  gauge.collected++;
});
const GAUGE_INTERVAL_MS = 60_000;
const gaugeTimer = setInterval(() => {
  if (gauge.built === 0) return;
}, GAUGE_INTERVAL_MS);
gaugeTimer.unref?.();

/**
 * Export the gauge to OTLP/Grafana as metrics. `meter` is a live binding that
 * is a Noop until `initObservability()` runs after SDK start, so register the
 * instruments lazily on first request (the SDK is up by the time traffic
 * arrives). `mcp.server.alive` is the leak indicator; built/collected are
 * monotonic counters for rate/gap analysis.
 */
let metricsRegistered = false;
function ensureGaugeMetrics(): void {
  if (metricsRegistered) return;
  metricsRegistered = true;
  try {
    const alive = meter.createObservableGauge("mcp.server.alive", {
      description:
        "Per-request MCP servers built but not yet GC-collected (rising floor = leak)",
      unit: "{server}",
    });
    alive.addCallback((r) => r.observe(gauge.built - gauge.collected));

    const built = meter.createObservableCounter("mcp.server.built", {
      description: "Total per-request MCP servers constructed",
      unit: "{server}",
    });
    built.addCallback((r) => r.observe(gauge.built));

    const collected = meter.createObservableCounter("mcp.server.collected", {
      description: "Total per-request MCP servers reclaimed by GC",
      unit: "{server}",
    });
    collected.addCallback((r) => r.observe(gauge.collected));
  } catch (err) {
    console.error("[serve-mcp] failed to register gauge metrics:", err);
  }
}

/**
 * The SDK transport's JSON-response mode returns a Promise from
 * `handleRequest` that is resolved only by `send()` delivering the final
 * response. `transport.close()` does NOT settle it (cleanup just deletes the
 * stream mapping — verified through SDK 1.29), so a request that aborts
 * mid-handler leaves `handleRequest` pending forever. Awaiting it would pin
 * this frame — and through it the server, transport, request, and every tool
 * schema — as a permanent GC root. Race it against the abort signal so the
 * frame always settles.
 */
function raceAbort(
  promise: Promise<Response>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.resolve(new Response(null, { status: 499 }));
  }
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => {
      resolve(new Response(null, { status: 499 }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(res);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export async function serveMcpRequest(
  server: CloseableServer,
  transport: RequestTransport,
  request: Request,
  label: string,
  options?: ServeMcpOptions,
): Promise<Response> {
  const signal = request.signal;

  ensureGaugeMetrics();
  gauge.built++;
  collectedRegistry.register(server, null);

  // Idempotent: the abort listener and the stream guard's onDone can both fire
  // (e.g. disconnect racing body-complete) — teardown must run exactly once.
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    gauge.closed++;
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
    response = await raceAbort(transport.handleRequest(request), signal);
  } catch (err) {
    close();
    throw err;
  }
  if (signal?.aborted) {
    close();
    return response;
  }
  return guardResponseStream(response, label, close);
}
