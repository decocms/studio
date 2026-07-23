# Investigation Tools & Infrastructure Inventory

**Found in:** `decocms/studio` repository (loaded from connectionId: `conn_viS0AjFZ1cffE5x13DQU_`)

## 1. ClickHouse Connection & Monitoring Infrastructure

### Files & References

| File Path | Purpose |
|-----------|---------|
| `/app/repo/apps/mesh/src/monitoring/clickhouse-setup.md` | Complete setup guide for ClickHouse monitoring (manual provisioning) |
| `/app/repo/apps/mesh/src/monitoring/schema.ts` | OTel log attribute keys, monitoring row schemas, conversion functions |
| `/app/repo/apps/mesh/src/monitoring/query-engine.ts` | QueryEngine abstraction (DuckDB for dev, ClickHouse for prod) |
| `/app/repo/apps/mesh/src/storage/monitoring-sql.ts` | Dashboard SQL queries (ClickHouse and DuckDB dialects) |
| `/app/repo/apps/mesh/src/observability/index.ts` | OpenTelemetry setup with OTLP/ClickHouse exporters |

### ClickHouse Stats Lake Connection Details

- **Known ID**: `conn_la7-Xv8sU9RrenfUmiPIf` (mentioned in your request)
- **View Name**: `studio_monitoring_logs` (production dashboard reads from this)
- **Source Table**: `otel_logs` (populated by OpenTelemetry ClickHouse exporter)
- **Service Name Filter**: Scoped by `ServiceName = 'studio'` (supports multi-tenant isolation)
- **Access**: Read-only for app; manual view creation required

---

## 2. Monitoring Data Schema

### Core Log Attributes (OTel Log Record)

All prefixed with `studio.monitoring.*` and stored as `LogAttributes`:

```
organization_id          tenant filter (every query)
connection_id            tool/connection identifier
connection_title         human-readable tool name
tool_name                MCP tool/operation name
input                    JSON string (query parameters)
output                   JSON string (result)
is_error                 boolean (0/1)
error_message            exception/error text
duration_ms              execution time (used for p50/p95/p99)
timestamp                ISO 8601 (bucketing + range filters)
user_id                  user identifier
request_id               trace/correlation ID
user_agent               client/user agent
virtual_mcp_id           virtual MCP connection identifier
properties               JSON string (custom metadata)
type                     'tool_call' or 'llm_call'
```

### Output Table Shape (Flattened for Dashboard)

**File**: `/app/repo/apps/mesh/src/monitoring/schema.ts` (lines 42–61)

```typescript
interface MonitoringRow {
  v: 1;                           // schema version
  id: string;                     // SpanId
  type: string;                   // tool_call | llm_call
  organization_id: string;
  connection_id: string;
  connection_title: string;
  tool_name: string;
  input: string;                  // JSON
  output: string;                 // JSON
  is_error: number;               // 0 or 1
  error_message: string | null;
  duration_ms: number;
  timestamp: string;              // ISO 8601
  user_id: string | null;
  request_id: string;
  user_agent: string | null;
  virtual_mcp_id: string | null;
  properties: string | null;      // JSON
}
```

---

## 3. Query Engine & SQL Dialects

### Implementation Pattern

**File**: `/app/repo/apps/mesh/src/monitoring/query-engine.ts` (lines 13–19)

```typescript
interface QueryEngine {
  query(sql: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  destroy?(): void | Promise<void>;
}
```

### Supported Backends

| Backend | Use Case | Location |
|---------|----------|----------|
| **ClickHouseClientEngine** | Production (remote HTTPS) | `@clickhouse/client` |
| **DuckDBEngine** | Local dev + self-hosted | `@duckdb/node-api` (embedded) |
| **DuckDB + GCS** | Multi-tenant on object storage | S3-compatible httpfs extension |

### Dashboard SQL Queries

**File**: `/app/repo/apps/mesh/src/storage/monitoring-sql.ts` (2201 lines)

- **Time bucketing**: `toStartOfInterval()` (ClickHouse) vs `time_bucket()` (DuckDB)
- **Group-by columns**: `connection_id`, `user_id`, `tool_name`, `virtual_mcp_id`
- **Safe filters**: validated JSONPath expressions, interval parsing, identifier escaping
- **Metrics derived**: count, avg, p50/p95/p99 duration, error rate

---

## 4. ClickHouse Setup Instructions

### View Creation (Manual Provisioning)

**File**: `/app/repo/apps/mesh/src/monitoring/clickhouse-setup.md` (Step 2, lines 77–99)

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

### Prerequisites

1. ClickHouse instance reachable over HTTP (set `CLICKHOUSE_URL`)
2. `otel_logs` table populated by OpenTelemetry exporter
3. Must have read access only (no write required for app)

### Optional Performance Tuning

**File**: `/app/repo/apps/mesh/src/monitoring/clickhouse-setup.md` (Step 3, lines 157–173)

```sql
ALTER TABLE otel_logs
  ADD INDEX idx_studio_org
  LogAttributes['studio.monitoring.organization_id']
  TYPE bloom_filter GRANULARITY 4;
```

---

## 5. Debugging & Instrumentation Setup

### OpenTelemetry Integration

**File**: `/app/repo/apps/mesh/src/observability/index.ts`

- **OTLP Exporters**:
  - `OTLPTraceExporter` (proto over gRPC/HTTP)
  - `OTLPLogExporter` (proto over gRPC/HTTP)
  - `PrometheusExporter` (metrics)
  
- **Local Fallback Exporters** (for tests / offline):
  - `NDJSONTraceExporter` → `/logs/<org>/traces.ndjson`
  - `NDJSONLogExporter` → `/logs/<org>/logs.ndjson`
  - `NDJSONMetricExporter` → `/logs/<org>/metrics.ndjson`

### Sampling Configuration

**File**: `/app/repo/apps/mesh/src/observability/index.ts` (lines 62–79)

```typescript
const HEAD_SAMPLER_RATIO = 1.0; // 100% sampling — all errors must reach HyperDX
// SampledLogRecordProcessor: non-error logs sampled at `ratio`; ERROR/FATAL always pass
```

### Monitoring Span Name

```typescript
const MONITORING_SPAN_NAME = "mcp.proxy.callTool";
```

---

## 6. Multi-Tenant Scoping

### Environment Separation Pattern

**File**: `/app/repo/apps/mesh/src/monitoring/clickhouse-setup.md` (Step 2, lines 71–76)

When multiple Studio deployments share one `otel_logs` table:

```sql
-- Create per-environment view in separate database
CREATE OR REPLACE VIEW production.studio_monitoring_logs AS
SELECT ... FROM otel_logs
WHERE ServiceName = 'studio'
  AND LogAttributes['studio.monitoring.type'] IN ('tool_call', 'llm_call')
  AND ResourceAttributes['deployment.environment'] = 'production';
```

Each deployment points `CLICKHOUSE_URL` at its database.

---

## 7. Related Repositories & Configurations

### Tool Endpoint Configuration

**File**: `/app/repo/.deco/tools/.endpoint.json`

```json
{
  "url": "http://localhost:3000/mcp/virtual-mcp/vir_...",
  "headers": {
    "Authorization": "Bearer <token>",
    "x-org-id": "<org-id>"
  },
  "expiresAt": <unix-ms>
}
```

This is the Studio's local MCP connection endpoint (for triggering other agents).

### Package Structure

- **mesh** (`/apps/mesh/`) — Core supervision & monitoring backend
  - `src/monitoring/` — ClickHouse schema, query engine, exporters
  - `src/storage/` — SQL-based monitoring storage layer
  - `src/observability/` — OTel setup, instrumentation

---

## 8. Key Files for Your Investigation Workflow

### To Query `sites-otica-isabela` or Service ID 57

**Current Limitation**: The monitoring infrastructure here is scoped to **Studio's own tool execution** (connection, tool_name, duration, errors). It does **not yet expose**:
- Service IDs from the monitored cluster (site-specific services)
- Grafana metrics (latency, CPU, memory per service)
- CDN edge metrics (raw_cloudflare, raw_cloudflare_firewall)
- Application errors from the upstream error system

**To cross-reference**:
- Service names/IDs are managed separately (not found in this repo search)
- Grafana/ClickStack integration is via the `apnjvob_*` tools (Observability API)
- The connection ID `conn_la7-Xv8sU9RrenfUmiPIf` is the **read path** into Stats Lake

### Investigation Tools Referenced in Your Brief

The following tools are expected to be available in your agent context (not found in this repo):

| Tool | Purpose |
|------|---------|
| `RESPOND_TO_EVENT` | Record investigation verdict (snooze/expected/fixed/watching) |
| `INVESTIGATE_ERROR` | Open investigation on an error; record findings |
| `ERROR_DETAIL` | Drill into one error; lifecycle + per-service peaks |
| `SERVICE_DETAIL` | Service drill-down; top errors + Grafana metrics |
| `GRAFANA_SITE_DETAIL` | Per-site health; pods, restarts, OOMs, elevated 5xx |
| `GRAFANA_SITE_PODS` | Per-pod breakdown (ready/notReady, restarts, CPU/mem) |
| `GRAFANA_TIMESERIES` | Metric timeseries (rps, errorRate, p95, cpuCores, etc.) |
| `GRAFANA_RECENT_EVENTS` | K8s state changes (restarts, OOM, scale, pod status) |
| `CDN_DAILY_OVERVIEW` | CDN daily usage per site (requests, cache hit, error rate) |
| `CDN_TOP_URLS_DAILY` | Top URLs by day; status code, method, cache, latency |
| `CDN_RAW_REQUESTS` | Raw per-request rows from Cloudflare (retention ~2d) |
| `CDN_RAW_FIREWALL` | WAF/firewall events (RuleID, Action, Country, RayID) |
| `CLICKHOUSE_QUERY` | Raw SQL against ClickHouse (raw_cloudflare, otel_logs, etc.) |
| `GRAFANA_QUERY_PROMQL` | PromQL against cluster Prometheus |

---

## 9. Recommendations for Your Setup

1. **Verify ClickHouse View**: Confirm `studio_monitoring_logs` exists and is populated
   ```sql
   SELECT count() FROM studio_monitoring_logs WHERE timestamp >= now() - INTERVAL 1 HOUR;
   ```

2. **Cross-reference Service IDs**: The site `sites-otica-isabela` and service ID 57 are likely in a **separate system** (the application error tracking / Grafana backend). Use the `SERVICE_DETAIL` and `GRAFANA_SITE_DETAIL` tools to fetch those.

3. **Tap into Stats Lake**: Once you have service ID 57, query raw metrics via `apnjvob_CLICKHOUSE_QUERY` on tables like:
   - `raw_cloudflare` (CDN edge requests, partitioned on `ClientRequestHost` + `EdgeEndTimestamp`)
   - `otel_logs` (application logs; now you know the schema)

4. **Audit Tool Instrumentation**: All tools called via Studio are logged to `studio_monitoring_logs`. Query it to debug slow or failing investigation tools yourself.

---

## 10. File Index (Absolute Paths in Loaded Repo)

```
/app/repo/apps/mesh/src/monitoring/clickhouse-setup.md      [ClickHouse setup guide]
/app/repo/apps/mesh/src/monitoring/schema.ts                 [OTel → monitoring row schema]
/app/repo/apps/mesh/src/monitoring/query-engine.ts           [QueryEngine interface + DuckDB/ClickHouse impl]
/app/repo/apps/mesh/src/monitoring/query-engine.test.ts      [Tests + examples]
/app/repo/apps/mesh/src/storage/monitoring-sql.ts            [Dashboard SQL queries]
/app/repo/apps/mesh/src/observability/index.ts               [OTel setup & instrumentation]
/app/repo/.deco/tools/.endpoint.json                         [Local MCP connection endpoint]
```

---

## Summary

You have **infrastructure in place** to query ClickHouse via the Stats Lake connection (`conn_la7`). The schema is OTel-native and scoped by organization. However, the **service-specific investigation tools** (SERVICE_DETAIL, GRAFANA_*, CDN_*) are provided separately as part of your agent context, not in the Studio repo. Use them to drill into latency/error spikes, then correlate those findings with tool execution traces in `studio_monitoring_logs`.
