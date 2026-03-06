/**
 * Shared span enrichment function for monitoring.
 *
 * Single source of truth for setting mesh.* span attributes.
 * Called by both MonitoringTransport and proxy-monitoring.ts middleware.
 *
 * Responsibilities:
 * - Set all MESH_ATTR.* span attributes
 * - Apply PII redaction to input, output, AND error_message
 * - Handle missing optional fields
 * - Skip enrichment when organizationId is empty
 */

import type { Span } from "@opentelemetry/api";
import { MESH_ATTR } from "./schema";
import { RegexRedactor } from "./redactor";

// Singleton redactor instance (patterns are compiled once)
const redactor = new RegexRedactor();

export interface EnrichSpanParams {
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
}

/**
 * Enrich an OTel span with monitoring attributes.
 *
 * IMPORTANT: Call this BEFORE span.end(). Once a span is ended,
 * the ReadableSpan snapshot is frozen and attributes set after
 * end() may not be exported.
 */
export function enrichMonitoringSpan(
  span: Span,
  params: EnrichSpanParams,
): void {
  if (!params.organizationId) return;

  // Apply PII redaction to input, output, and error message
  const redactedInput = redactor.redact(params.toolArguments ?? {});
  const redactedOutput = redactor.redact(params.result ?? {});
  const redactedErrorMessage = params.errorMessage
    ? redactor.redactString(params.errorMessage)
    : "";

  span.setAttributes({
    [MESH_ATTR.ORGANIZATION_ID]: params.organizationId,
    [MESH_ATTR.CONNECTION_ID]: params.connectionId,
    [MESH_ATTR.CONNECTION_TITLE]: params.connectionTitle,
    [MESH_ATTR.TOOL_NAME]: params.toolName,
    [MESH_ATTR.TOOL_INPUT]: JSON.stringify(redactedInput),
    [MESH_ATTR.TOOL_OUTPUT]: JSON.stringify(redactedOutput),
    [MESH_ATTR.TOOL_IS_ERROR]: params.isError,
    [MESH_ATTR.TOOL_ERROR_MESSAGE]: redactedErrorMessage,
    [MESH_ATTR.TOOL_DURATION_MS]: params.duration,
    [MESH_ATTR.USER_ID]: params.userId || "",
    [MESH_ATTR.REQUEST_ID]: params.requestId,
    [MESH_ATTR.USER_AGENT]: params.userAgent || "",
    [MESH_ATTR.VIRTUAL_MCP_ID]: params.virtualMcpId || "",
    [MESH_ATTR.TOOL_PROPERTIES]: params.properties
      ? JSON.stringify(params.properties)
      : "",
  });
}
