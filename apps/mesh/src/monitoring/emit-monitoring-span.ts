import type { Tracer } from "@opentelemetry/api";
import {
  MONITORING_SPAN_ATTRIBUTES,
  MONITORING_SPAN_NAME,
} from "./parquet-schema";
import { RegexRedactor } from "./redactor";

// Shared redactor instance (stateless, safe to reuse)
const redactor = new RegexRedactor();

export interface MonitoringSpanData {
  tracer: Tracer;
  organizationId: string;
  connectionId: string;
  connectionTitle: string;
  toolName: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  isError: boolean;
  errorMessage?: string | null;
  durationMs: number;
  userId?: string | null;
  requestId: string;
  userAgent?: string | null;
  virtualMcpId?: string | null;
  properties?: Record<string, string> | null;
}

/**
 * Emit a dedicated monitoring span with all tool call data as attributes.
 * This span is picked up by ParquetSpanExporter and written to Parquet.
 *
 * Used by both MonitoringTransport (WebSocket/stdio) and
 * proxy-monitoring middleware (HTTP Streamable).
 */
export function emitMonitoringSpan(data: MonitoringSpanData): void {
  // Apply PII redaction to input, output, and error message
  const redactedInput = redactor.redact(data.input);
  const redactedOutput = redactor.redact(data.output);
  const redactedErrorMessage = data.errorMessage
    ? redactor.redactString(data.errorMessage)
    : "";

  const span = data.tracer.startSpan(MONITORING_SPAN_NAME);
  span.setAttributes({
    [MONITORING_SPAN_ATTRIBUTES.ORGANIZATION_ID]: data.organizationId,
    [MONITORING_SPAN_ATTRIBUTES.CONNECTION_ID]: data.connectionId,
    [MONITORING_SPAN_ATTRIBUTES.CONNECTION_TITLE]: data.connectionTitle,
    [MONITORING_SPAN_ATTRIBUTES.TOOL_NAME]: data.toolName,
    [MONITORING_SPAN_ATTRIBUTES.INPUT]: JSON.stringify(redactedInput),
    [MONITORING_SPAN_ATTRIBUTES.OUTPUT]: JSON.stringify(redactedOutput),
    [MONITORING_SPAN_ATTRIBUTES.IS_ERROR]: data.isError,
    [MONITORING_SPAN_ATTRIBUTES.ERROR_MESSAGE]: redactedErrorMessage,
    [MONITORING_SPAN_ATTRIBUTES.DURATION_MS]: data.durationMs,
    [MONITORING_SPAN_ATTRIBUTES.USER_ID]: data.userId ?? "",
    [MONITORING_SPAN_ATTRIBUTES.REQUEST_ID]: data.requestId,
    [MONITORING_SPAN_ATTRIBUTES.USER_AGENT]: data.userAgent ?? "",
    [MONITORING_SPAN_ATTRIBUTES.VIRTUAL_MCP_ID]: data.virtualMcpId ?? "",
    [MONITORING_SPAN_ATTRIBUTES.PROPERTIES]: data.properties
      ? JSON.stringify(data.properties)
      : "",
  });
  span.end();
}
