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

        // A 404 on the in-pod daemon (`/_sandbox/*`) means the sandbox handle
        // is gone (idle-evicted). That's expected control flow — the proxy maps
        // it to 410/`gone` and the UI self-heals — not a failure. Open Studio
        // tabs poll `/events` + `/git/status` against reaped sandboxes, so
        // marking these ERROR floods the error dashboard with benign 404s.
        const isDaemonSandboxGone404 =
          response.status === 404 && url.pathname.startsWith("/_sandbox/");

        if (
          response.status >= 400 &&
          !isMcpSseProbe405 &&
          !isDaemonSandboxGone404
        ) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${response.status}`,
          });
        } else {
          if (isDaemonSandboxGone404) span.setAttribute("sandbox.gone", true);
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
