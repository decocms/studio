/**
 * ClickHouse DDL management for monitoring rollup tables.
 *
 * Creates the pre-aggregated rollup table and materialized view that
 * eliminate per-query full-table scans on monitoring_metrics.
 *
 * Uses its own @clickhouse/client instance with client.command() for DDL,
 * keeping the QueryEngine interface read-only. When a ClickHouse Cloud Query
 * API config is supplied instead of a url, DDL is sent over the Query API.
 */

import {
  runClickHouseQueryApi,
  type ClickHouseQueryApiConfig,
} from "./query-engine";

const ROLLUP_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS monitoring_metrics_rollup_1m (
  bucket DateTime,
  organization_id String,
  connection_id String,
  tool_name String,
  name String,
  status String,
  value SimpleAggregateFunction(sum, Float64),
  hist_count SimpleAggregateFunction(sum, Float64),
  hist_sum SimpleAggregateFunction(sum, Float64),
  hist_min SimpleAggregateFunction(min, Float64),
  hist_max SimpleAggregateFunction(max, Float64),
  hist_bucket_counts AggregateFunction(sumForEach, Array(Float64)),
  hist_boundaries SimpleAggregateFunction(any, Array(Float64))
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (organization_id, name, bucket, connection_id, tool_name, status)
TTL bucket + INTERVAL 90 DAY
`;

const MATERIALIZED_VIEW_DDL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS monitoring_metrics_rollup_1m_mv
TO monitoring_metrics_rollup_1m
AS SELECT
  toStartOfMinute(timestamp) AS bucket,
  organization_id,
  connection_id,
  tool_name,
  name,
  status,
  sum(value) AS value,
  sum(hist_count) AS hist_count,
  sum(hist_sum) AS hist_sum,
  min(hist_min) AS hist_min,
  max(hist_max) AS hist_max,
  sumForEachState(
    JSONExtract(hist_bucket_counts, 'Array(Float64)')
  ) AS hist_bucket_counts,
  any(
    JSONExtract(hist_boundaries, 'Array(Float64)')
  ) AS hist_boundaries
FROM monitoring_metrics
GROUP BY organization_id, name, bucket, connection_id, tool_name, status
`;

export type ClickHouseRollupTarget =
  | { url: string }
  | { queryApi: ClickHouseQueryApiConfig };

/**
 * Run ClickHouse DDL to create the rollup table and materialized view.
 *
 * Logs errors but does not throw — queries detect the rollup table's
 * existence at query time and fall back to the raw table automatically.
 * (Creating these objects requires a credential with DDL rights; a
 * read-only Query API key will land on the raw-table fallback.)
 */
export async function ensureClickHouseRollup(
  target: ClickHouseRollupTarget,
): Promise<void> {
  try {
    if ("queryApi" in target) {
      await runClickHouseQueryApi(target.queryApi, ROLLUP_TABLE_DDL);
      console.log(
        "[clickhouse-schema] monitoring_metrics_rollup_1m table ready",
      );
      await runClickHouseQueryApi(target.queryApi, MATERIALIZED_VIEW_DDL);
      console.log(
        "[clickhouse-schema] monitoring_metrics_rollup_1m_mv view ready",
      );
      return;
    }

    const { createClient } = await import("@clickhouse/client");
    const client = createClient({ url: target.url });
    try {
      await client.command({ query: ROLLUP_TABLE_DDL });
      console.log(
        "[clickhouse-schema] monitoring_metrics_rollup_1m table ready",
      );

      await client.command({ query: MATERIALIZED_VIEW_DDL });
      console.log(
        "[clickhouse-schema] monitoring_metrics_rollup_1m_mv view ready",
      );
    } finally {
      await client.close();
    }
  } catch (err) {
    console.error(
      "[clickhouse-schema] Failed to create rollup DDL (queries will fall back to raw table):",
      err,
    );
  }
}
