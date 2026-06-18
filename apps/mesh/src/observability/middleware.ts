/**
 * OpenTelemetry Tracing Middleware for Hono
 *
 * Provides request-level tracing with common HTTP attributes
 * and mesh-specific context.
 */

import type { MiddlewareHandler } from "hono";
import {
  SpanStatusCode,
  type Exception,
  type Histogram,
  type Span,
} from "@opentelemetry/api";
import {
  meter,
  tracer,
  withRequest,
  reqCorrelationId,
  setCorrelationIdHeader,
} from "./index";
import type { Env } from "../api/hono-env";
import { isHealthPath } from "../api/utils/paths";

// Lazily created on first request: `meter` is a no-op until initObservability()
// runs sdk.start(), so creating the instrument at module load would bind it to
// the NoopMeter. The ESM live binding means reading `meter` here picks up the
// real meter once it's reassigned.
let _durationHistogram: Histogram | undefined;
const durationHistogram = (): Histogram =>
  (_durationHistogram ??= meter.createHistogram(
    "http.server.request.duration",
    {
      description: "Duration of inbound HTTP requests handled by the API.",
      unit: "s",
    },
  ));

/**
 * Tracing middleware that creates a span for each request
 * with common HTTP attributes and mesh-specific context.
 */
export const tracingMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (isHealthPath(c.req.path)) {
    return next();
  }

  const req = c.req.raw;
  const url = new URL(req.url);
  const start = performance.now();

  // Create context with request for sampling decisions
  const parentContext = withRequest(req);

  // Check for debug correlation ID
  const correlationId = reqCorrelationId(req);
  const attributes = {
    "http.request.url": req.url,
    "http.request.method": req.method,
    "http.request.body.size": req.headers.get("content-length") ?? undefined,
    "url.scheme": url.protocol.replace(":", ""),
    "server.address": url.host,
    "url.query": url.search || undefined,
    "url.path": url.pathname,
    "user_agent.original": req.headers.get("user-agent") ?? undefined,
    "request.internal": req.headers.has("traceparent"),
    ...(correlationId ? { "trace.debug.id": correlationId } : {}),
  };

  await tracer.startActiveSpan(
    `${req.method} ${url.pathname}`,
    {
      attributes,
    },
    parentContext,
    async (span: Span) => {
      // Store span in context for child spans
      c.set("rootSpan", span);

      try {
        await next();
      } catch (e) {
        span.recordException(e as Exception);
        span.setStatus({ code: SpanStatusCode.ERROR });
        const errorMessage =
          typeof e === "object" && e && "message" in e
            ? String(e.message)
            : JSON.stringify(e);
        console.error("error: ", errorMessage, attributes);
        throw e;
      } finally {
        const status = c.res?.status ?? 500;
        const isErr = status >= 500;

        span.setStatus({
          code: isErr ? SpanStatusCode.ERROR : SpanStatusCode.OK,
        });
        span.setAttribute("http.response.status_code", status);

        // Add mesh-specific attributes if available
        const meshContext = c.get("meshContext");
        if (meshContext) {
          if (meshContext.auth.user?.id) {
            span.setAttribute("studio.user.id", meshContext.auth.user.id);
          }
          if (meshContext.auth.apiKey?.id) {
            span.setAttribute("studio.api_key.id", meshContext.auth.apiKey.id);
          }
          if (meshContext.organization?.id) {
            span.setAttribute(
              "studio.organization.id",
              meshContext.organization.id,
            );
          }
        }

        // Set debug correlation ID on response if present
        if (correlationId) {
          setCorrelationIdHeader(c.res.headers, correlationId);
        }

        // Latency histogram for Prometheus (the span carries the trace; this is
        // the only HTTP-duration signal scraped at /metrics). Labelled by the
        // matched route pattern — not the raw path — to keep cardinality bounded.
        durationHistogram().record((performance.now() - start) / 1000, {
          "http.request.method": req.method,
          "http.route": c.req.routePath,
          "http.response.status_code": status,
        });

        span.end();
      }
    },
  );
};
