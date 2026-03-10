/**
 * Monitoring schema and constants.
 *
 * Single source of truth for:
 * - mesh.monitoring.* OTel log attribute keys (used by emit + NDJSONLogExporter)
 * - MonitoringRow type (used by NDJSONLogExporter + ClickHouseMonitoringStorage)
 * - Log-record-to-row conversion (used by NDJSONLogExporter)
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

/** Shared constants for mesh.monitoring.* log attribute keys. */
export const MONITORING_LOG_ATTR = {
  TYPE: "mesh.monitoring.type",
  ORGANIZATION_ID: "mesh.monitoring.organization_id",
  CONNECTION_ID: "mesh.monitoring.connection_id",
  CONNECTION_TITLE: "mesh.monitoring.connection_title",
  TOOL_NAME: "mesh.monitoring.tool_name",
  INPUT: "mesh.monitoring.input",
  OUTPUT: "mesh.monitoring.output",
  IS_ERROR: "mesh.monitoring.is_error",
  ERROR_MESSAGE: "mesh.monitoring.error_message",
  DURATION_MS: "mesh.monitoring.duration_ms",
  USER_ID: "mesh.monitoring.user_id",
  REQUEST_ID: "mesh.monitoring.request_id",
  USER_AGENT: "mesh.monitoring.user_agent",
  VIRTUAL_MCP_ID: "mesh.monitoring.virtual_mcp_id",
  PROPERTIES: "mesh.monitoring.properties",
} as const;

export const MONITORING_LOG_TYPE_VALUE = "tool_call";

/** Minimal log-record-like input for conversion. */
export interface LogRecordInput {
  id: string;
  timestampNano: bigint;
  attributes: Record<string, string | number | boolean | undefined>;
}

/** Convert OTel log record attributes to a flat monitoring row for NDJSON. */
export function logRecordToMonitoringRow(
  record: LogRecordInput,
): MonitoringRow {
  const { attributes: a } = record;

  const isError = a[MONITORING_LOG_ATTR.IS_ERROR];
  const durationMs = a[MONITORING_LOG_ATTR.DURATION_MS];

  return {
    id: record.id,
    organization_id: getAttr(a, MONITORING_LOG_ATTR.ORGANIZATION_ID),
    connection_id: getAttr(a, MONITORING_LOG_ATTR.CONNECTION_ID),
    connection_title: getAttr(a, MONITORING_LOG_ATTR.CONNECTION_TITLE),
    tool_name: getAttr(a, MONITORING_LOG_ATTR.TOOL_NAME),
    input: getAttr(a, MONITORING_LOG_ATTR.INPUT),
    output: getAttr(a, MONITORING_LOG_ATTR.OUTPUT),
    is_error: isError === true || isError === 1 || isError === "true" ? 1 : 0,
    error_message: getAttrNullable(a, MONITORING_LOG_ATTR.ERROR_MESSAGE),
    duration_ms:
      typeof durationMs === "number" ? durationMs : Number(durationMs) || 0,
    timestamp: new Date(
      Number(record.timestampNano / 1_000_000n),
    ).toISOString(),
    user_id: getAttrNullable(a, MONITORING_LOG_ATTR.USER_ID),
    request_id: getAttr(a, MONITORING_LOG_ATTR.REQUEST_ID),
    user_agent: getAttrNullable(a, MONITORING_LOG_ATTR.USER_AGENT),
    virtual_mcp_id: getAttrNullable(a, MONITORING_LOG_ATTR.VIRTUAL_MCP_ID),
    properties: getAttrNullable(a, MONITORING_LOG_ATTR.PROPERTIES),
  };
}
