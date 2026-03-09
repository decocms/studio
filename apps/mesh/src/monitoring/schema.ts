/**
 * Monitoring span schema and constants.
 *
 * Single source of truth for:
 * - mesh.* OTel span attribute keys (used by enrichSpan + exporter)
 * - MonitoringRow type (used by NDJSONSpanExporter + ClickHouseMonitoringStorage)
 * - Span-to-row conversion (used by NDJSONSpanExporter)
 * - Shared constants (span name, default data path)
 */

/** The span name used for all monitoring spans. Must match the MonitoringAlwaysSampler. */
export const MONITORING_SPAN_NAME = "mcp.proxy.callTool";

/** Default base path for monitoring NDJSON files. */
import { homedir } from "node:os";
import { join } from "node:path";
export const DEFAULT_MONITORING_URI = join(
  homedir(),
  "deco",
  "system",
  "monitoring",
);

/** Shared constants for mesh.* span attribute keys. */
export const MESH_ATTR = {
  ORGANIZATION_ID: "mesh.organization.id",
  CONNECTION_ID: "mesh.connection.id",
  CONNECTION_TITLE: "mesh.connection.title",
  TOOL_NAME: "mesh.tool.name",
  TOOL_INPUT: "mesh.tool.input",
  TOOL_OUTPUT: "mesh.tool.output",
  TOOL_IS_ERROR: "mesh.tool.is_error",
  TOOL_ERROR_MESSAGE: "mesh.tool.error_message",
  TOOL_DURATION_MS: "mesh.tool.duration_ms",
  USER_ID: "mesh.user.id",
  REQUEST_ID: "mesh.request.id",
  USER_AGENT: "mesh.user_agent",
  VIRTUAL_MCP_ID: "mesh.virtual_mcp.id",
  TOOL_PROPERTIES: "mesh.tool.properties",
} as const;

/**
 * A single monitoring row written to NDJSON and read by ClickHouse.
 *
 * Fields use snake_case to match ClickHouse column conventions.
 * Timestamps are ISO 8601 strings for ClickHouse parseDateTimeBestEffort().
 */
export interface MonitoringRow {
  id: string;
  organization_id: string;
  connection_id: string;
  connection_title: string;
  tool_name: string;
  input: string;
  output: string;
  is_error: number; // 0 or 1
  error_message: string | null;
  duration_ms: number;
  timestamp: string; // ISO 8601
  user_id: string | null;
  request_id: string;
  user_agent: string | null;
  virtual_mcp_id: string | null;
  properties: string | null;
}

/** Minimal span-like input for conversion. */
export interface SpanInput {
  spanId: string;
  startTimeUnixNano: bigint;
  attributes: Record<string, string | number | boolean | undefined>;
}

function getAttr(
  attrs: Record<string, string | number | boolean | undefined>,
  key: string,
): string {
  const val = attrs[key];
  return val != null ? String(val) : "";
}

function getAttrNullable(
  attrs: Record<string, string | number | boolean | undefined>,
  key: string,
): string | null {
  const val = attrs[key];
  return val != null && val !== "" ? String(val) : null;
}

/** Convert OTel span attributes to a flat monitoring row for NDJSON. */
export function spanToMonitoringRow(span: SpanInput): MonitoringRow {
  const { attributes: a } = span;

  const isError = a[MESH_ATTR.TOOL_IS_ERROR];
  const durationMs = a[MESH_ATTR.TOOL_DURATION_MS];

  return {
    id: span.spanId,
    organization_id: getAttr(a, MESH_ATTR.ORGANIZATION_ID),
    connection_id: getAttr(a, MESH_ATTR.CONNECTION_ID),
    connection_title: getAttr(a, MESH_ATTR.CONNECTION_TITLE),
    tool_name: getAttr(a, MESH_ATTR.TOOL_NAME),
    input: getAttr(a, MESH_ATTR.TOOL_INPUT),
    output: getAttr(a, MESH_ATTR.TOOL_OUTPUT),
    is_error: isError === true || isError === 1 || isError === "true" ? 1 : 0,
    error_message: getAttrNullable(a, MESH_ATTR.TOOL_ERROR_MESSAGE),
    duration_ms:
      typeof durationMs === "number" ? durationMs : Number(durationMs) || 0,
    timestamp: new Date(
      Number(span.startTimeUnixNano / 1_000_000n),
    ).toISOString(),
    user_id: getAttrNullable(a, MESH_ATTR.USER_ID),
    request_id: getAttr(a, MESH_ATTR.REQUEST_ID),
    user_agent: getAttrNullable(a, MESH_ATTR.USER_AGENT),
    virtual_mcp_id: getAttrNullable(a, MESH_ATTR.VIRTUAL_MCP_ID),
    properties: getAttrNullable(a, MESH_ATTR.TOOL_PROPERTIES),
  };
}
