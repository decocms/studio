# ClickHouse monitoring setup (manual)

The hosted Studio dashboard reads monitoring data from a ClickHouse view named
`studio_monitoring_logs`. This view is **not** created by the app at runtime — it
is a one-time provisioning step you run against your ClickHouse / ClickStack
instance. The app only ever needs **read** access (`CLICKHOUSE_URL`).

> Only needed when `CLICKHOUSE_URL` is set (production / hosted). Local dev and
> self-hosted deployments without ClickHouse use the DuckDB + NDJSON path and
> need none of this.

## How it works

Studio emits monitoring telemetry as standard OTel **log records** whose
attributes are prefixed `studio.monitoring.*`. With an OTLP collector that writes
to ClickHouse (the ClickStack / OpenTelemetry ClickHouse-exporter setup), those
records land in the `otel_logs` table.

The dashboard SQL (`storage/monitoring-sql.ts`) expects a **flat** row shape
(`organization_id`, `tool_name`, `duration_ms`, …). The view below projects
`otel_logs` into that shape. It is virtual (no storage); ClickHouse pushes the
dashboard's `WHERE` predicates down into `otel_logs`. Metrics (counts, averages,
percentiles) are derived from these same rows — there is no separate metrics
table.

The view scopes by `ServiceName` (Studio's OTel `service.name`, default
`studio`). Because Studio emits the standard OTel-native schema, this means the
view works whether you give Studio its own `otel_logs` table or point it at a
**shared** `otel_logs` in a multi-app event lake — the `ServiceName` predicate
keeps other applications' logs out.

## Prerequisites

1. A ClickHouse instance reachable over HTTP, set as `CLICKHOUSE_URL` on the
   Studio deployment (read access is enough for the app).
2. An `otel_logs` table being populated by the collector with Studio's log
   records (i.e. the app is deployed and emitting `studio.monitoring.*`).

## Step 1 — verify the `otel_logs` schema

The DDL below assumes the **standard OpenTelemetry ClickHouse exporter** schema:
`Timestamp` (DateTime64), `SpanId` (String), `ServiceName`
(LowCardinality(String)), and `LogAttributes` (`Map(String, String)`). Confirm with:

```sql
DESCRIBE TABLE otel_logs;
```

If your ClickStack / collector uses different column names (some HyperDX
deployments do), adjust the `SELECT` in Step 2 accordingly — only the source
column names change; the output (aliased) columns must stay exactly as written
because the dashboard SQL depends on them.

## Step 2 — create the view

Run once. Safe to re-run with `CREATE OR REPLACE VIEW` if the attribute keys ever
change (they must match `MONITORING_LOG_ATTR` in `monitoring/schema.ts`).

The `ServiceName = 'studio'` filter assumes the default service name. If you run
Studio with a custom `OTEL_SERVICE_NAME`, use that value instead.

```sql
CREATE OR REPLACE VIEW studio_monitoring_logs AS
SELECT
  SpanId AS id,
  LogAttributes['studio.monitoring.organization_id'] AS organization_id,
  LogAttributes['studio.monitoring.connection_id'] AS connection_id,
  LogAttributes['studio.monitoring.connection_title'] AS connection_title,
  LogAttributes['studio.monitoring.tool_name'] AS tool_name,
  LogAttributes['studio.monitoring.input'] AS input,
  LogAttributes['studio.monitoring.output'] AS output,
  LogAttributes['studio.monitoring.is_error'] = 'true' AS is_error,
  LogAttributes['studio.monitoring.error_message'] AS error_message,
  toFloat64OrZero(LogAttributes['studio.monitoring.duration_ms']) AS duration_ms,
  Timestamp AS timestamp,
  LogAttributes['studio.monitoring.user_id'] AS user_id,
  LogAttributes['studio.monitoring.request_id'] AS request_id,
  LogAttributes['studio.monitoring.user_agent'] AS user_agent,
  LogAttributes['studio.monitoring.virtual_mcp_id'] AS virtual_mcp_id,
  LogAttributes['studio.monitoring.properties'] AS properties
FROM otel_logs
WHERE ServiceName = 'studio'
  AND LogAttributes['studio.monitoring.type'] IN ('tool_call', 'llm_call');
```

## Step 3 — sanity check

```sql
SELECT count() FROM studio_monitoring_logs WHERE timestamp >= now() - INTERVAL 1 HOUR;
```

A non-zero count (once traffic has flowed) means the dashboard will read data.

## Output columns (the contract)

The dashboard depends on these aliased columns existing on the view:

| column            | source                                                        | notes                          |
| ----------------- | ------------------------------------------------------------- | ------------------------------ |
| `id`              | `SpanId`                                                      | per-record identifier          |
| `organization_id` | `LogAttributes['studio.monitoring.organization_id']`          | tenant filter (every query)    |
| `connection_id`   | `LogAttributes['studio.monitoring.connection_id']`            |                                |
| `connection_title`| `LogAttributes['studio.monitoring.connection_title']`         |                                |
| `tool_name`       | `LogAttributes['studio.monitoring.tool_name']`                |                                |
| `input`           | `LogAttributes['studio.monitoring.input']`                    | JSON string                    |
| `output`          | `LogAttributes['studio.monitoring.output']`                   | JSON string                    |
| `is_error`        | `LogAttributes['studio.monitoring.is_error'] = 'true'`        | UInt8 (0/1)                    |
| `error_message`   | `LogAttributes['studio.monitoring.error_message']`            |                                |
| `duration_ms`     | `toFloat64OrZero(LogAttributes['studio.monitoring.duration_ms'])` | used for avg / quantile  |
| `timestamp`       | `Timestamp`                                                   | bucketing + range filters      |
| `user_id`         | `LogAttributes['studio.monitoring.user_id']`                  |                                |
| `request_id`      | `LogAttributes['studio.monitoring.request_id']`              |                                |
| `user_agent`      | `LogAttributes['studio.monitoring.user_agent']`              |                                |
| `virtual_mcp_id`  | `LogAttributes['studio.monitoring.virtual_mcp_id']`          |                                |
| `properties`      | `LogAttributes['studio.monitoring.properties']`              | JSON string                    |

## Performance (optional, recommended at scale)

Dashboard queries filter by `organization_id` and a time range (default 30-day
lookback). Partitioning `otel_logs` by day/month and adding a skip index on the
org attribute keeps scans cheap, e.g.:

```sql
ALTER TABLE otel_logs
  ADD INDEX idx_studio_org
  mapValues(LogAttributes)['studio.monitoring.organization_id']
  TYPE bloom_filter GRANULARITY 4;
```

(Exact index syntax depends on your ClickHouse version / `otel_logs` definition.)
If query latency becomes a problem, a per-minute rollup (AggregatingMergeTree
with `quantileTDigestState`) over these rows is the next step — intentionally
left out for now.
