/**
 * Monitoring schema and constants.
 *
 * Single source of truth for:
 * - studio.monitoring.* OTel log attribute keys (used by emit + NDJSONLogExporter)
 *
 * IMPORTANT: these attribute keys are a contract with the storage backend.
 * In ClickHouse OTel-native mode the queries in storage/monitoring-sql.ts read
 * them as `LogAttributes['studio.monitoring.*']` and the rollup MV in
 * clickhouse-schema.ts groups by them. Renaming a key here means updating both.
 * - MonitoringRow type (used by NDJSONLogExporter + SqlMonitoringStorage)
 * - Log-record-to-row conversion (used by NDJSONLogExporter)
 * - Shared constants (span name, default data path)
 */

/** The span name used for all monitoring spans. Must match the MonitoringAlwaysSampler. */
export const MONITORING_SPAN_NAME = "mcp.proxy.callTool";

/** Default base paths for monitoring NDJSON files. */
import { join } from "node:path";
import { getSettings } from "../settings";
export function getDataDir(): string {
  return getSettings().dataDir;
}
export function getLogsDir(): string {
  return join(getSettings().dataDir, "logs");
}
export function getTracesDir(): string {
  return join(getSettings().dataDir, "traces");
}
export function getMetricsDir(): string {
  return join(getSettings().dataDir, "metrics");
}

/**
 * A single monitoring row written to NDJSON and read by ClickHouse.
 *
 * Fields use snake_case to match ClickHouse column conventions.
 * Timestamps are ISO 8601 strings for ClickHouse parseDateTimeBestEffort().
 */
export interface MonitoringRow {
  v: 1;
  id: string;
  type: string;
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

/** Shared constants for studio.monitoring.* log attribute keys. */
export const MONITORING_LOG_ATTR = {
  TYPE: "studio.monitoring.type",
  ORGANIZATION_ID: "studio.monitoring.organization_id",
  CONNECTION_ID: "studio.monitoring.connection_id",
  CONNECTION_TITLE: "studio.monitoring.connection_title",
  TOOL_NAME: "studio.monitoring.tool_name",
  INPUT: "studio.monitoring.input",
  OUTPUT: "studio.monitoring.output",
  IS_ERROR: "studio.monitoring.is_error",
  ERROR_MESSAGE: "studio.monitoring.error_message",
  DURATION_MS: "studio.monitoring.duration_ms",
  USER_ID: "studio.monitoring.user_id",
  REQUEST_ID: "studio.monitoring.request_id",
  USER_AGENT: "studio.monitoring.user_agent",
  VIRTUAL_MCP_ID: "studio.monitoring.virtual_mcp_id",
  PROPERTIES: "studio.monitoring.properties",
} as const;

export const MONITORING_LOG_TYPE_VALUE = "tool_call";
export const MONITORING_LOG_TYPE_LLM_CALL = "llm_call";

/** Connection ID used for all LLM calls emitted by Decopilot. */
export const DECOPILOT_CONNECTION_ID = "decopilot";

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
    v: 1,
    id: record.id,
    type: getAttr(a, MONITORING_LOG_ATTR.TYPE) || MONITORING_LOG_TYPE_VALUE,
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

export function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

export function hrTimeToISO(hrTime: [number, number]): string {
  return new Date(hrTimeToMs(hrTime)).toISOString();
}

export interface TraceRow {
  v: 1;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: number;
  status: number;
  status_message: string | null;
  start_time: string;
  end_time: string;
  duration_ms: number;
  service_name: string;
  attributes: string;
  events: string;
  links: string;
  resource: string;
}

export interface MetricRow {
  v: 1;
  name: string;
  type: "sum" | "histogram";
  unit: string;
  timestamp: string;
  organization_id: string;
  connection_id: string;
  tool_name: string;
  status: string;
  error_type: string;
  value: number;
  hist_count: number;
  hist_sum: number;
  hist_min: number;
  hist_max: number;
  hist_boundaries: string;
  hist_bucket_counts: string;
}
