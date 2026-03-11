/**
 * OpenTelemetry Tracing Middleware for Hono
 *
 * Provides request-level tracing with common HTTP attributes
 * and mesh-specific context.
 */

import type { MiddlewareHandler } from "hono";
import { SpanStatusCode, type Exception, type Span } from "@opentelemetry/api";
import {
  tracer,
  withRequest,
  reqCorrelationId,
  setCorrelationIdHeader,
} from "./index";
import type { Env } from "../api/hono-env";

/**
 * Tracing middleware that creates a span for each request
 * with common HTTP attributes and mesh-specific context.
 */
export const tracingMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const req = c.req.raw;
  const url = new URL(req.url);

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
            span.setAttribute("mesh.user.id", meshContext.auth.user.id);
          }
          if (meshContext.auth.apiKey?.id) {
            span.setAttribute("mesh.api_key.id", meshContext.auth.apiKey.id);
          }
          if (meshContext.organization?.id) {
            span.setAttribute(
              "mesh.organization.id",
              meshContext.organization.id,
            );
          }
        }

        // Set debug correlation ID on response if present
        if (correlationId) {
          setCorrelationIdHeader(c.res.headers, correlationId);
        }

        span.end();
      }
    },
  );
};
