/**
 * Fetch Instrumentation for Bun
 *
 * Wraps global fetch to add OpenTelemetry tracing for outbound HTTP requests.
 * Propagates trace context via W3C Trace Context headers.
 *
 * Note: This is needed because Bun's fetch doesn't use undici,
 * so @opentelemetry/instrumentation-undici doesn't work.
 */

import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  type Exception,
} from "@opentelemetry/api";
import { tracer } from "../index";

// Store original fetch before wrapping
const originalFetch = globalThis.fetch;

/**
 * Classify a thrown fetch error as a benign abort so it isn't surfaced as an
 * error span. Two shapes leak into error tracking as if they were failures:
 *
 * - `TimeoutError` — `AbortSignal.timeout()` elapsed ("The operation timed
 *   out."). Used by the sandbox daemon-client config/health probes.
 * - `AbortError` — a caller cancelled the request via `AbortController.abort()`
 *   ("The operation was aborted."). Idle teardown, in-flight replacement, client
 *   disconnect, and SWR revalidation cleanup all do this as normal control flow.
 *
 * Returns the abort reason for span tagging, or null for genuine failures.
 */
function classifyAbort(
  error: unknown,
  signal: AbortSignal | undefined,
): "timeout" | "cancelled" | null {
  const name = error instanceof Error ? error.name : undefined;
  if (name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "cancelled";
  // Fallback: the caller's own signal fired but the runtime threw a
  // non-standard error shape.
  if (signal?.aborted) return "cancelled";
  return null;
}

function benignSandbox4xx(status: number, pathname: string): string | null {
  if (pathname.startsWith("/_sandbox/")) {
    if (status === 404) return "daemon_gone";
    if (status === 409) return "daemon_not_ready";
  }
  if (status === 404 && pathname.includes("/sandboxclaims/")) {
    return "claim_gone";
  }
  return null;
}

function benignPreview404(status: number, pathname: string): string | null {
  if (
    status === 404 &&
    (pathname === "/.decofile" ||
      pathname === "/live/_meta" ||
      // A site with no icon sprite (icon-select previews just fall back to text).
      pathname === "/sprites.svg")
  ) {
    return "not_a_deco_site";
  }
  return null;
}

/**
 * Bun's `fetch` rejects with this shape when the peer closes the TCP
 * connection mid-request (e.g. an in-pod sandbox daemon torn down by idle
 * eviction). Distinct from an abort — nobody cancelled, the socket just went
 * away. Matched on message + the common reset/broken-pipe codes since Bun
 * gives these no stable error `name`.
 */
function isConnectionClosed(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes("socket connection was closed")) return true;
  const code = (error as { code?: string }).code;
  return code === "ECONNRESET" || code === "EPIPE";
}

/**
 * Instrumented fetch that creates spans for outbound requests
 * and propagates trace context.
 */
async function instrumentedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Parse URL from input
  let url: URL;
  let method: string;

  if (input instanceof Request) {
    url = new URL(input.url);
    method = init?.method ?? input.method;
  } else if (input instanceof URL) {
    url = input;
    method = init?.method ?? "GET";
  } else {
    url = new URL(input);
    method = init?.method ?? "GET";
  }

  // Create span name: "HTTP METHOD host"
  const spanName = `${method} ${url.host}`;

  return tracer.startActiveSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "url.full": url.href,
        "url.scheme": url.protocol.replace(":", ""),
        "url.path": url.pathname,
        "url.query": url.search || undefined,
        "server.address": url.hostname,
        "server.port": url.port ? Number(url.port) : undefined,
      },
    },
    async (span) => {
      try {
        // Prepare headers with trace context propagation
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : {}),
        );

        // Inject trace context into headers (W3C Trace Context)
        propagation.inject(context.active(), headers, {
          set: (carrier: Headers, key: string, value: string) =>
            carrier.set(key, value),
        });

        // Create new init with propagated headers
        const instrumentedInit: RequestInit = {
          ...init,
          headers,
        };

        // Make the actual fetch call with original fetch
        const response = await originalFetch(input, instrumentedInit);

        // Record response attributes
        span.setAttribute("http.response.status_code", response.status);

        // The MCP Streamable HTTP transport opens its server->client stream
        // with a GET (Accept: text/event-stream); the spec defines 405 as the
        // expected "no SSE stream offered" reply, which the SDK swallows. Don't
        // surface that handshake as an error span. All other 4xx/5xx are real
        // client-span errors per OTel HTTP conventions.
        const isMcpSseProbe405 =
          response.status === 405 &&
          method === "GET" &&
          (headers.get("accept") ?? "").includes("text/event-stream");

        // Sandbox lifecycle churn (reaped/booting daemon, GC'd claim) is
        // expected control flow the caller self-heals — not a failure. See
        // benignSandbox4xx; marking these ERROR floods the error dashboard.
        const sandboxLifecycle =
          response.status >= 400
            ? benignSandbox4xx(response.status, url.pathname)
            : null;

        const previewProbe =
          response.status >= 400
            ? benignPreview404(response.status, url.pathname)
            : null;

        if (
          response.status >= 400 &&
          !isMcpSseProbe405 &&
          !sandboxLifecycle &&
          !previewProbe
        ) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${response.status}`,
          });
        } else {
          if (sandboxLifecycle) {
            span.setAttribute("sandbox.lifecycle", sandboxLifecycle);
          }
          if (previewProbe) {
            span.setAttribute("preview.probe", previewProbe);
          }
          span.setStatus({ code: SpanStatusCode.OK });
        }

        return response;
      } catch (error) {
        const signal =
          init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const abortReason = classifyAbort(error, signal ?? undefined);
        if (abortReason) {
          // Benign control-flow abort (timeout / caller cancellation), not a
          // server failure. Tag the span with the reason and leave its status
          // UNSET so it stays out of the error bucket while remaining visible
          // and distinguishable in traces. We still re-throw — control flow is
          // the caller's concern, untouched.
          span.setAttribute("abort.reason", abortReason);
        } else if (
          isConnectionClosed(error) &&
          url.pathname.startsWith("/_sandbox/")
        ) {
          span.setAttribute("sandbox.lifecycle", "connection_closed");
        } else {
          // Record exception and set error status
          span.recordException(error as Exception);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Fetch failed",
          });
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Enable fetch instrumentation by replacing global fetch
 */
export function enableFetchInstrumentation(): void {
  // @ts-expect-error - Bun's fetch has extra properties like preconnect
  globalThis.fetch = instrumentedFetch;
}

/** Internal helpers exposed for unit tests only. */
export const __test = {
  benignSandbox4xx,
  benignPreview404,
  isConnectionClosed,
};
