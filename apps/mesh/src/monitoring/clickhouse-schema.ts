/**
 * ClickHouse DDL for the monitoring dashboard.
 *
 * Studio emits monitoring telemetry as standard OTel log records (attributes
 * prefixed `studio.monitoring.*`). In production those land in the ClickStack
 * OTel-native `otel_logs` table. The dashboard queries in storage/monitoring-sql.ts
 * expect a FLAT row shape (organization_id, tool_name, duration_ms, ...), so we
 * expose a thin VIEW that projects `otel_logs` into that shape. The view is
 * virtual (no storage); ClickHouse pushes the WHERE predicates down into otel_logs.
 *
 * NOTE: this DDL assumes the standard OpenTelemetry ClickHouse exporter schema
 * for `otel_logs` (columns `Timestamp`, `SpanId`, `LogAttributes Map(...)`).
 * If the deployed ClickStack/collector uses different column names, adjust the
 * SELECT below to match.
 */

import { MONITORING_LOG_ATTR } from "./schema";

const A = MONITORING_LOG_ATTR;

/**
 * View that projects otel_logs (OTel-native) into the flat monitoring row shape
 * the dashboard SQL reads. Only monitoring log records (tool_call / llm_call)
 * are included.
 */
const MONITORING_VIEW_DDL = `
CREATE VIEW IF NOT EXISTS studio_monitoring_logs AS
SELECT
  SpanId AS id,
  LogAttributes['${A.ORGANIZATION_ID}'] AS organization_id,
  LogAttributes['${A.CONNECTION_ID}'] AS connection_id,
  LogAttributes['${A.CONNECTION_TITLE}'] AS connection_title,
  LogAttributes['${A.TOOL_NAME}'] AS tool_name,
  LogAttributes['${A.INPUT}'] AS input,
  LogAttributes['${A.OUTPUT}'] AS output,
  LogAttributes['${A.IS_ERROR}'] = 'true' AS is_error,
  LogAttributes['${A.ERROR_MESSAGE}'] AS error_message,
  toFloat64OrZero(LogAttributes['${A.DURATION_MS}']) AS duration_ms,
  Timestamp AS timestamp,
  LogAttributes['${A.USER_ID}'] AS user_id,
  LogAttributes['${A.REQUEST_ID}'] AS request_id,
  LogAttributes['${A.USER_AGENT}'] AS user_agent,
  LogAttributes['${A.VIRTUAL_MCP_ID}'] AS virtual_mcp_id,
  LogAttributes['${A.PROPERTIES}'] AS properties
FROM otel_logs
WHERE LogAttributes['${A.TYPE}'] IN ('tool_call', 'llm_call')
`;

/**
 * Create the monitoring view over otel_logs.
 *
 * Logs errors but does not throw — if the view can't be created (e.g. otel_logs
 * doesn't exist yet), monitoring queries will simply fail at read time and the
 * dashboard shows empty state, which is preferable to blocking startup.
 */
export async function ensureClickHouseViews(
  clickhouseUrl: string,
): Promise<void> {
  try {
    const { createClient } = await import("@clickhouse/client");
    const client = createClient({ url: clickhouseUrl });

    try {
      await client.command({ query: MONITORING_VIEW_DDL });
      console.log("[clickhouse-schema] studio_monitoring_logs view ready");
    } finally {
      await client.close();
    }
  } catch (err) {
    console.error(
      "[clickhouse-schema] Failed to create monitoring view (dashboard queries may fail until otel_logs exists):",
      err,
    );
  }
}
