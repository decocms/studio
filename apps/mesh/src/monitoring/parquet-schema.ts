/**
 * Parquet schema definition for monitoring spans.
 *
 * This schema is shared between:
 * - ParquetSpanExporter (writes Parquet via DuckDB COPY)
 * - DuckDBMonitoringStorage (reads Parquet via read_parquet)
 *
 * Columns match the existing MonitoringLog type for backwards compatibility
 * with MCP tool interfaces.
 */

/**
 * OpenTelemetry span attribute keys used for monitoring enrichment.
 * The ParquetSpanExporter reads these attributes and maps them to Parquet columns.
 */
export const MONITORING_SPAN_ATTRIBUTES = {
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

/**
 * The monitoring span name used to identify monitoring-enriched spans.
 * The ParquetSpanExporter filters spans by this name.
 */
export const MONITORING_SPAN_NAME = "mesh.monitoring.tool_call";

/**
 * DuckDB CREATE TABLE statement for the in-memory staging table
 * used by ParquetSpanExporter before COPY TO parquet.
 */
export const CREATE_STAGING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS monitoring_staging (
  id VARCHAR,
  organization_id VARCHAR NOT NULL,
  connection_id VARCHAR NOT NULL,
  connection_title VARCHAR NOT NULL,
  tool_name VARCHAR NOT NULL,
  input VARCHAR,
  output VARCHAR,
  is_error BOOLEAN NOT NULL,
  error_message VARCHAR,
  duration_ms INTEGER NOT NULL,
  "timestamp" TIMESTAMP NOT NULL,
  user_id VARCHAR,
  request_id VARCHAR NOT NULL,
  user_agent VARCHAR,
  virtual_mcp_id VARCHAR,
  properties VARCHAR
)
`;
