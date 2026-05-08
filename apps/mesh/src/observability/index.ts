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
  SpanStatusCode,
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
import { NDJSONLogExporter } from "../monitoring/ndjson-log-exporter";
import { NDJSONMetricExporter } from "../monitoring/ndjson-metric-exporter";
import { NDJSONTraceExporter } from "../monitoring/ndjson-trace-exporter";
import {
  getLogsDir,
  getMetricsDir,
  getTracesDir,
  MONITORING_LOG_ATTR,
} from "../monitoring/schema";
import { truncateString } from "../monitoring/truncate-string";
import { getSettings } from "../settings";

import {
  BatchLogRecordProcessor,
  type LogRecordProcessor,
  type SdkLogRecord,
} from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  SamplingDecision,
  SamplingResult,
} from "@opentelemetry/sdk-trace-base";

// Constants
const DEBUG_QS = "__d";
const REQUEST_CONTEXT_KEY = createContextKey("Current request");
const HEAD_SAMPLER_RATIO = 1.0; // 100% sampling — all errors must reach HyperDX

// Wraps a LogRecordProcessor and samples non-error records at `ratio`.
// ERROR/FATAL severity always passes through regardless of ratio.
class SampledLogRecordProcessor implements LogRecordProcessor {
  constructor(
    private inner: LogRecordProcessor,
    private ratio: number,
  ) {}

  onEmit(
    record: SdkLogRecord,
    context?: import("@opentelemetry/api").Context,
  ): void {
    const isError =
      record.severityNumber !== undefined &&
      record.severityNumber >= SeverityNumber.ERROR;
    if (isError || Math.random() < this.ratio) {
      this.inner.onEmit(record, context);
    }
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

// Truncates mesh.monitoring.output to 500 bytes before forwarding to the
// wrapped exporter (OTLP/HyperDX). The NDJSON local exporter receives the
// full value because it wraps a different inner processor.
class TruncateMonitoringOutputProcessor implements LogRecordProcessor {
  constructor(
    private inner: LogRecordProcessor,
    private maxBytes: number,
  ) {}

  onEmit(
    record: SdkLogRecord,
    context?: import("@opentelemetry/api").Context,
  ): void {
    const outputKey = MONITORING_LOG_ATTR.OUTPUT;
    const output = record.attributes?.[outputKey];
    if (typeof output === "string" && output.length > this.maxBytes) {
      const truncated = truncateString(output, this.maxBytes);
      this.inner.onEmit(
        {
          ...record,
          attributes: { ...record.attributes, [outputKey]: truncated },
        } as SdkLogRecord,
        context,
      );
    } else {
      this.inner.onEmit(record, context);
    }
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

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
 * Create the debug sampler with 10% ratio fallback.
 * Monitoring data flows through OTel log records (not spans), so
 * monitoring spans no longer need special sampling treatment.
 */
const headSampler = new DebugSampler(new RatioSampler(HEAD_SAMPLER_RATIO));

/**
 * Observability state — initialized lazily via initObservability().
 *
 * The tracer/meter/logger are available immediately (they use OTel API
 * no-ops until the SDK is started), but the NDJSON exporters and SDK
 * require Settings and must wait until after buildSettings() completes.
 */
let monitoringLogExporter: NDJSONLogExporter | null = null;
let monitoringTraceExporter: NDJSONTraceExporter | null = null;
let monitoringMetricExporter: NDJSONMetricExporter | null = null;
let monitoringMetricReader: PeriodicExportingMetricReader | null = null;
let _initialized = false;

/**
 * Initialize the OpenTelemetry SDK with settings-dependent configuration.
 *
 * Must be called after buildSettings() completes. Safe to call multiple
 * times — subsequent calls are no-ops.
 */
export function initObservability(): void {
  if (_initialized) return;

  const _settings = getSettings();

  const traceExporter = _settings.clickhouseUrl
    ? new OTLPTraceExporter()
    : undefined;

  // Always create local NDJSON exporters (skip only in tests — they create
  // timers and write to disk, neither of which is needed when running `bun test`).
  monitoringLogExporter =
    _settings.nodeEnv === "test"
      ? null
      : new NDJSONLogExporter({ basePath: getLogsDir() });

  monitoringTraceExporter =
    _settings.nodeEnv === "test"
      ? null
      : new NDJSONTraceExporter({ basePath: getTracesDir() });

  monitoringMetricExporter =
    _settings.nodeEnv === "test"
      ? null
      : new NDJSONMetricExporter({ basePath: getMetricsDir() });

  monitoringMetricReader = monitoringMetricExporter
    ? new PeriodicExportingMetricReader({
        exporter: monitoringMetricExporter,
        exportIntervalMillis: 60_000,
      })
    : null;

  if (
    !process.env.OTEL_RESOURCE_ATTRIBUTES?.includes("deployment.environment")
  ) {
    const env = process.env.STUDIO_ENV ?? process.env.NODE_ENV ?? "unknown";
    process.env.OTEL_RESOURCE_ATTRIBUTES = process.env.OTEL_RESOURCE_ATTRIBUTES
      ? `${process.env.OTEL_RESOURCE_ATTRIBUTES},deployment.environment=${env}`
      : `deployment.environment=${env}`;
  }

  const sdk = new NodeSDK({
    serviceName: _settings.otelServiceName,
    traceExporter,
    metricReaders: [
      prometheusExporter,
      ...(monitoringMetricReader ? [monitoringMetricReader] : []),
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sampler: headSampler,
    spanProcessors: [
      ...(monitoringTraceExporter
        ? [
            new BatchSpanProcessor(monitoringTraceExporter, {
              scheduledDelayMillis: 60_000,
              maxExportBatchSize: 1000,
            }),
          ]
        : []),
    ],
    logRecordProcessors: [
      ...(_settings.clickhouseUrl
        ? (() => {
            const isProd =
              (process.env.STUDIO_ENV ?? process.env.NODE_ENV) === "prod" ||
              process.env.NODE_ENV === "production";
            const logSampleRatio = isProd ? 1.0 : 0.1;
            const batch = new BatchLogRecordProcessor(new OTLPLogExporter());
            const truncated = new TruncateMonitoringOutputProcessor(
              batch,
              8_000,
            );
            return [new SampledLogRecordProcessor(truncated, logSampleRatio)];
          })()
        : []),
      ...(monitoringLogExporter
        ? [
            new BatchLogRecordProcessor(monitoringLogExporter, {
              scheduledDelayMillis: 60_000,
              maxExportBatchSize: 1000,
            }),
          ]
        : []),
    ],
    instrumentations: [new RuntimeNodeInstrumentation()],
  });

  // Start SDK to enable metric collection and tracing
  sdk.start();

  // Re-obtain meter/tracer now that the SDK registered the real providers.
  // The module-level `meter` and `tracer` were evaluated before sdk.start()
  // and point to NoopMeter/NoopTracer. Reassigning ensures all callers that
  // import these get working instruments.
  meter = metrics.getMeter("studio", "1.0.0");
  tracer = trace.getTracer("studio", "1.0.0");

  // Enable custom Bun fetch instrumentation (must be after SDK start)
  // This wraps global fetch with tracing since Bun's fetch doesn't use undici
  enableFetchInstrumentation();

  _initialized = true;
}

/**
 * Get tracer instance
 */
export let tracer = trace.getTracer("studio", "1.0.0");

/**
 * Get meter instance.
 *
 * Uses `let` so initObservability() can reassign after sdk.start().
 * The module-level call returns a NoopMeter when evaluated before the SDK
 * starts; the reassignment ensures all subsequent callers get a real meter.
 */
export let meter = metrics.getMeter("studio", "1.0.0");

/**
 * Get logger instance
 */
const logger = logs.getLogger("studio", "1.0.0");

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
 * Flush all buffered monitoring data to disk.
 *
 * In local mode the SDK's BatchLogRecordProcessor and NDJSONLogExporter both
 * buffer records in memory.  Calling this drains both layers so that
 * monitoring queries see the most recent data without waiting for the
 * next timer-based flush (up to 60 s).
 *
 * In cloud mode (CLICKHOUSE_URL set) this flushes the OTLP exporters.
 */
export async function flushMonitoringData(): Promise<void> {
  // Flush logs, traces, and metrics in parallel (each pair is independent).
  // Within each pair the SDK processor must flush before the NDJSON exporter.
  // Use allSettled so one rejection doesn't prevent the other flushes from completing.
  const results = await Promise.allSettled([
    // Logs
    (async () => {
      const logProvider = logs.getLoggerProvider();
      if ("forceFlush" in logProvider) {
        await (logProvider as { forceFlush(): Promise<void> }).forceFlush();
      }
      if (monitoringLogExporter) {
        await monitoringLogExporter.forceFlush();
      }
    })(),
    // Traces
    (async () => {
      const provider = trace.getTracerProvider();
      if ("forceFlush" in provider) {
        await (provider as { forceFlush(): Promise<void> }).forceFlush();
      }
      if (monitoringTraceExporter) {
        await monitoringTraceExporter.forceFlush();
      }
    })(),
    // Metrics
    (async () => {
      if (monitoringMetricReader) {
        await monitoringMetricReader.forceFlush();
      }
      if (monitoringMetricExporter) {
        await monitoringMetricExporter.forceFlush();
      }
    })(),
  ]);

  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) {
    throw rejected.reason;
  }
}

/**
 * Run an async function inside an OpenTelemetry span.
 * Sets OK/ERROR status and records exceptions automatically.
 */
export function traced<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attrs?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { attributes: attrs as Record<string, string> },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        const err =
          error instanceof Error
            ? error
            : new Error(String(error ?? "unknown"));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err.message,
        });
        span.recordException(err);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Export tracing middleware
 */
export { tracingMiddleware } from "./middleware";
