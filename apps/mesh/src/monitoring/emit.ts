/**
 * Emit a monitoring OTel log record.
 *
 * Writes monitoring data to an OTel log record
 * instead of span attributes. This decouples monitoring data from
 * the trace lifecycle, allowing log-based exporters (NDJSONLogExporter)
 * to capture tool calls independently.
 *
 * Responsibilities:
 * - Emit a log record with all MONITORING_LOG_ATTR.* attributes
 * - Apply PII redaction to input, output, AND error_message
 * - Handle missing optional fields
 * - Skip emission when organizationId is empty
 */

import type { Context } from "@opentelemetry/api";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import { RegexRedactor } from "./redactor";
import { MONITORING_LOG_ATTR, MONITORING_LOG_TYPE_VALUE } from "./schema";

const redactor = new RegexRedactor();

export interface EmitMonitoringLogParams {
  organizationId: string;
  connectionId: string;
  connectionTitle: string;
  toolName: string;
  toolArguments: Record<string, unknown> | undefined;
  result: unknown;
  duration: number;
  isError: boolean;
  errorMessage: string | null;
  userId: string | null;
  requestId: string;
  userAgent: string | null;
  virtualMcpId: string | null;
  properties: Record<string, unknown> | null;
  /** Override the mesh.monitoring.type attribute. Defaults to "tool_call". */
  type?: string;
}

/**
 * Emit an OTel log record with monitoring attributes.
 *
 * Fail-safe: errors are silently swallowed so monitoring never
 * breaks tool call handling.
 */
export function emitMonitoringLog(
  params: EmitMonitoringLogParams,
  context?: Context,
): void {
  try {
    if (!params.organizationId) return;

    // Apply PII redaction to input, output, and error message
    const redactedInput = redactor.redact(params.toolArguments ?? {});
    const redactedOutput = redactor.redact(params.result ?? {});
    const redactedErrorMessage = params.errorMessage
      ? redactor.redactString(params.errorMessage)
      : "";

    logs.getLogger("mesh.monitoring", "1.0.0").emit({
      severityNumber: params.isError
        ? SeverityNumber.ERROR
        : SeverityNumber.INFO,
      severityText: params.isError ? "ERROR" : "INFO",
      body: params.toolName,
      attributes: {
        [MONITORING_LOG_ATTR.TYPE]: params.type ?? MONITORING_LOG_TYPE_VALUE,
        [MONITORING_LOG_ATTR.ORGANIZATION_ID]: params.organizationId,
        [MONITORING_LOG_ATTR.CONNECTION_ID]: params.connectionId,
        [MONITORING_LOG_ATTR.CONNECTION_TITLE]: params.connectionTitle,
        [MONITORING_LOG_ATTR.TOOL_NAME]: params.toolName,
        [MONITORING_LOG_ATTR.INPUT]: JSON.stringify(redactedInput),
        [MONITORING_LOG_ATTR.OUTPUT]: JSON.stringify(redactedOutput),
        [MONITORING_LOG_ATTR.IS_ERROR]: params.isError,
        [MONITORING_LOG_ATTR.ERROR_MESSAGE]: redactedErrorMessage,
        [MONITORING_LOG_ATTR.DURATION_MS]: params.duration,
        [MONITORING_LOG_ATTR.USER_ID]: params.userId || "",
        [MONITORING_LOG_ATTR.REQUEST_ID]: params.requestId,
        [MONITORING_LOG_ATTR.USER_AGENT]: params.userAgent || "",
        [MONITORING_LOG_ATTR.VIRTUAL_MCP_ID]: params.virtualMcpId || "",
        [MONITORING_LOG_ATTR.PROPERTIES]: params.properties
          ? JSON.stringify(params.properties)
          : "",
      },
      context,
    });
  } catch {
    // Monitoring emission must be fail-safe: telemetry errors
    // (e.g. circular references in JSON.stringify) should never
    // propagate and break tool call handling.
  }
}
