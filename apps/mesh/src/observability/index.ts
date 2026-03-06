/**
 * OpenTelemetry Observability Setup
 *
 * Provides distributed tracing, metrics collection, and logging
 * for the MCP Mesh.
 */

import {
  context,
  createContextKey,
  metrics,
  trace,
  type Attributes,
  type Context,
  type Exception,
  type Link,
  type Span,
  type SpanKind,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { enableFetchInstrumentation } from "./instrumentations/fetch";

import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  SamplingDecision,
  SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import { MONITORING_SPAN_NAME } from "@/monitoring/parquet-schema";
import { ParquetSpanExporter } from "@/monitoring/parquet-span-exporter";
import { DEFAULT_PARQUET_BASE_PATH } from "@/monitoring/parquet-paths";

// Constants
const DEBUG_QS = "__d";
const REQUEST_CONTEXT_KEY = createContextKey("Current request");
const HEAD_SAMPLER_RATIO = 0.1; // 10% sampling by default

// Sampler types - inline to avoid module resolution issues
interface Sampler {
  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult;
  toString(): string;
}

/**
 * Extract correlation ID from request (query param or header)
 */
export const reqCorrelationId = (req: Request): string | null => {
  const url = new URL(req.url);
  let correlationId = url.searchParams.get(DEBUG_QS);
  if (correlationId === "") {
    // __d present but no value, generate one
    return crypto.randomUUID();
  }
  if (!correlationId) {
    correlationId = req.headers.get("x-trace-debug-id");
  }
  return correlationId;
};

/**
 * Set correlation ID on response headers
 */
export const setCorrelationIdHeader = (
  headers: Headers,
  correlationId: string,
) => {
  try {
    headers.set("x-trace-debug-id", correlationId);
  } catch {
    // ignore if headers are immutable
  }
};

/**
 * Debug Sampler - always samples when __d query param or x-trace-debug-id header is present
 * Falls back to inner sampler (10% ratio) otherwise
 */
class DebugSampler implements Sampler {
  constructor(protected inner?: Sampler) {}

  shouldSample(
    ctx: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    // Always record monitoring spans — they carry tool call data for dashboards
    if (spanName === MONITORING_SPAN_NAME) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }

    const req = ctx.getValue(REQUEST_CONTEXT_KEY) as Request | undefined;

    // If no request context, fall back to inner sampler or record
    if (!req) {
      if (this.inner) {
        return this.inner.shouldSample(
          ctx,
          traceId,
          spanName,
          spanKind,
          attributes,
          links,
        );
      }
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }

    // Check for debug correlation ID
    const correlationId = reqCorrelationId(req);
    if (correlationId) {
      return {
        decision: SamplingDecision.RECORD_AND_SAMPLED,
        attributes: {
          "trace.debug.id": correlationId,
        },
      };
    }

    // Fall back to inner sampler
    if (this.inner) {
      const sampleDecision = this.inner.shouldSample(
        ctx,
        traceId,
        spanName,
        spanKind,
        attributes,
        links,
      );
      if (sampleDecision.decision === SamplingDecision.RECORD_AND_SAMPLED) {
        const newCorrelationId = crypto.randomUUID();
        sampleDecision.attributes = {
          ...(sampleDecision.attributes ?? {}),
          "trace.debug.id": newCorrelationId,
        };
      }
      return sampleDecision;
    }

    return { decision: SamplingDecision.NOT_RECORD };
  }

  toString(): string {
    return "DebugSampler";
  }
}

/**
 * Simple ratio-based sampler
 */
class RatioSampler implements Sampler {
  constructor(private ratio: number) {}

  shouldSample(): SamplingResult {
    if (Math.random() < this.ratio) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }
    return { decision: SamplingDecision.NOT_RECORD };
  }

  toString(): string {
    return `RatioSampler(${this.ratio})`;
  }
}

/**
 * Create Prometheus exporter as a MetricReader
 * This collects metrics from the SDK and exposes them for Prometheus to scrape
 * preventServerStart: true means we handle the HTTP endpoint ourselves via Hono
 */
export const prometheusExporter = new PrometheusExporter({
  preventServerStart: true,
});

/**
 * Create the debug sampler with 10% ratio fallback
 */
const headSampler = new DebugSampler(new RatioSampler(HEAD_SAMPLER_RATIO));

/**
 * Build span processors.
 *
 * - OTLP exporter: always added when OTEL_EXPORTER_OTLP_ENDPOINT is set (cloud)
 * - Parquet exporter: added when no OTLP endpoint (local mode — writes monitoring
 *   spans to time-partitioned Parquet files via DuckDB)
 */
const monitoringBasePath =
  process.env.MONITORING_PARQUET_PATH ?? DEFAULT_PARQUET_BASE_PATH;

const spanProcessors: BatchSpanProcessor[] = [];

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
}

// Local mode: write monitoring spans to Parquet
if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  spanProcessors.push(
    new BatchSpanProcessor(
      new ParquetSpanExporter({ basePath: monitoringBasePath }),
    ),
  );
}

/**
 * Initialize OpenTelemetry SDK
 */
const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "mesh",
  spanProcessors,
  metricReader: prometheusExporter as unknown as MetricReader,
  sampler: headSampler,
  logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
  instrumentations: [new RuntimeNodeInstrumentation()],
});

// Start SDK to enable metric collection and tracing
sdk.start();

// Enable custom Bun fetch instrumentation (must be after SDK start)
// This wraps global fetch with tracing since Bun's fetch doesn't use undici
enableFetchInstrumentation();

/**
 * Get tracer instance
 */
export const tracer = trace.getTracer("mesh", "1.0.0");

/**
 * Get meter instance
 */
export const meter = metrics.getMeter("mesh", "1.0.0");

/**
 * Get logger instance
 */
const logger = logs.getLogger("mesh", "1.0.0");

/**
 * Helper to emit a log record with current trace context
 * If the last argument is a plain object, it will be used as attributes
 */
const emitLog = (
  severityNumber: SeverityNumber,
  severityText: string,
  args: unknown[],
) => {
  let customAttributes: Record<string, unknown> = {};
  let messageArgs = args;

  // Check if the last argument is a plain object (not null, not array, not Error)
  const lastArg = args[args.length - 1];
  if (
    lastArg !== null &&
    typeof lastArg === "object" &&
    !Array.isArray(lastArg) &&
    !(lastArg instanceof Error) &&
    Object.getPrototypeOf(lastArg) === Object.prototype
  ) {
    customAttributes = lastArg as Record<string, unknown>;
    messageArgs = args.slice(0, -1);
  }

  const body = messageArgs
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === "object") {
        try {
          return JSON.stringify(arg);
        } catch {
          // Handle circular structures, BigInt, or other non-serializable values
          return "[Object]";
        }
      }
      return String(arg);
    })
    .join(" ");

  logger.emit({
    severityNumber,
    severityText,
    body,
    attributes: {
      "log.source": "console",
      ...customAttributes,
    },
  });
};

// Store original console methods
const originalConsole = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  debug: console.debug.bind(console),
};

/**
 * Intercept console methods to send logs via OTLP
 */
console.error = (...args: unknown[]) => {
  emitLog(SeverityNumber.ERROR, "ERROR", args);
  originalConsole.error(...args);
};

console.warn = (...args: unknown[]) => {
  emitLog(SeverityNumber.WARN, "WARN", args);
  originalConsole.warn(...args);
};

console.debug = (...args: unknown[]) => {
  emitLog(SeverityNumber.DEBUG, "DEBUG", args);
  originalConsole.debug(...args);
};

/**
 * Create a context with the request set for sampling decisions
 */
export const withRequest = (req: Request): Context => {
  return context.active().setValue(REQUEST_CONTEXT_KEY, req);
};

/**
 * Export context utilities for setting request context
 */
export { type Exception, type Span };

/**
 * Export tracing middleware
 */
export { tracingMiddleware } from "./middleware";
