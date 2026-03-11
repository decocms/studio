import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { type TraceRow, hrTimeToISO, hrTimeToMs } from "./schema";
import { NDJSONExporter, type NDJSONExporterOptions } from "./ndjson-exporter";

export type NDJSONTraceExporterOptions = NDJSONExporterOptions;

function spanToTraceRow(span: ReadableSpan): TraceRow {
  const resource = span.resource;
  const serviceName =
    (resource.attributes["service.name"] as string) ?? "unknown";

  return {
    v: 1,
    trace_id: span.spanContext().traceId,
    span_id: span.spanContext().spanId,
    parent_span_id: span.parentSpanContext?.spanId || null,
    name: span.name,
    kind: span.kind,
    status: span.status.code,
    status_message: span.status.message || null,
    start_time: hrTimeToISO(span.startTime),
    end_time: hrTimeToISO(span.endTime),
    duration_ms: hrTimeToMs(span.endTime) - hrTimeToMs(span.startTime),
    service_name: serviceName,
    attributes: JSON.stringify(span.attributes),
    events: JSON.stringify(span.events),
    links: JSON.stringify(span.links),
    resource: JSON.stringify(resource.attributes),
  };
}

export class NDJSONTraceExporter implements SpanExporter {
  private inner: NDJSONExporter<TraceRow>;

  constructor(options: NDJSONTraceExporterOptions) {
    this.inner = new NDJSONExporter<TraceRow>(options);
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const rows = spans.map(spanToTraceRow);

    this.inner
      .exportRows(rows)
      .then((result) => resultCallback(result))
      .catch(() => resultCallback({ code: ExportResultCode.FAILED }));
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    await this.inner.forceFlush();
  }
}
