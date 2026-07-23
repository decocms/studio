# Quick Reference: Querying ClickHouse for `sites-otica-isabela` & Service ID 57

## Overview

Your **observation tools** (`SERVICE_DETAIL`, `GRAFANA_*`, `CDN_*`, etc.) are part of the agent platform, NOT the Studio repo. However, the **ClickHouse Stats Lake** (`conn_la7-Xv8sU9RrenfUmiPIf`) is where application/CDN metrics land.

---

## How to Query the Stats Lake

### Current Service/Site Registration

Service ID 57 and site `sites-otica-isabela` are **NOT in the Studio monitoring schema** (which only tracks tool calls). They live in the upstream error/metrics system.

**To find them:**
1. Call `SERVICE_DETAIL` with `service="sites-otica-isabela"` or `service="57"`
2. This returns Grafana metrics + top errors (from the platform's service registry)
3. Use the returned service ID (if you only had the name) in subsequent queries

### Available ClickHouse Tables

**File**: `/app/repo/apps/mesh/src/monitoring/clickhouse-setup.md`

- **`otel_logs`** — Application/tool execution logs (OTel-native schema)
- **`studio_monitoring_logs`** — Flattened view of `otel_logs` for the dashboard
- **`raw_cloudflare`** (mentioned in your brief) — CDN edge requests
  - Partitioned by `ClientRequestHost` + `EdgeEndTimestamp`
  - Columns: Status, Method, CacheStatus, Country, Upstream latency, Request bytes, Response bytes, RayID
- **Other tables** (outside Studio repo scope):
  - `otel_traces` — Distributed tracing spans
  - Application error tables (via HyperDX integration)

### Query Pattern: Studio Monitoring Logs

If you want to audit **which tools ran` for site `sites-otica-isabela`:

```sql
SELECT
  timestamp,
  tool_name,
  duration_ms,
  is_error,
  error_message,
  request_id
FROM studio_monitoring_logs
WHERE organization_id = '<your-org>' 
  AND timestamp >= now() - INTERVAL 7 DAY
  AND (
    connection_title ILIKE '%otica-isabela%'
    OR properties ILIKE '%otica-isabela%'
  )
ORDER BY timestamp DESC
LIMIT 1000;
```

### Query Pattern: CDN Requests (raw_cloudflare)

To investigate edge latency spikes for `sites-otica-isabela`:

```sql
SELECT
  EdgeEndTimestamp,
  Status,
  Method,
  CacheStatus,
  Country,
  quantile(0.50)(Upstream.latency) AS p50_latency_ms,
  quantile(0.95)(Upstream.latency) AS p95_latency_ms,
  count() AS request_count,
  sum(ResponseBytes) AS total_bytes
FROM raw_cloudflare
WHERE ClientRequestHost = 'otica-isabela.com'  -- adjust to actual domain
  AND EdgeEndTimestamp >= now() - INTERVAL 7 DAY
GROUP BY EdgeEndTimestamp, Status, Method, CacheStatus, Country
ORDER BY EdgeEndTimestamp DESC;
```

**Key Constraint** (per your brief):
- Always filter with an **exact** `ClientRequestHost = 'value'` (no LIKE)
- Always filter by `EdgeEndTimestamp` range (no date-only filters)
- Query scans billions of rows; these filters are essential

---

## Investigation Workflow: Latency Spike at `sites-otica-isabela`

### Step 1: Get Service/Site Context

```
Call: SERVICE_DETAIL with service="sites-otica-isabela" or serviceId=57
Output: RPS, p50/p95/p99 latency, error rate, top errors, pod health
```

From this you learn:
- Service ID (if you started with the name)
- Which k8s namespace to inspect (`sites-otica-isabela` or similar)
- Traffic shape (trending up/down, error rate)

### Step 2: Drill Into Infrastructure

```
Call: GRAFANA_SITE_DETAIL with site="otica-isabela"
Output: Pod readiness, restarts, OOMs, CPU/mem vs request, 1h/24h deltas
```

### Step 3: Check CDN Layer

```
Call: CDN_DAILY_OVERVIEW with siteIds=[<from-step-1>]
Output: Per-day cache hit rate, 4xx/5xx counts, traffic, error rate
```

### Step 4: If Spike is Real, Investigate Deeper

```
Call: GRAFANA_TIMESERIES with metric="p95" namespace="sites-otica-isabela" windowMin=60
Output: Time series of p95 latency last 1h, ~60 buckets
```

```
Call: GRAFANA_RECENT_EVENTS with namespace="sites-otica-isabela" windowMin=60
Output: Crashes, restarts, OOMs, scale changes, pod status flips in last 1h
```

### Step 5: Query Raw ClickHouse if the Tool Layer Doesn't Explain It

```sql
-- Check if there's a spike in tool execution errors
SELECT
  toStartOfInterval(timestamp, INTERVAL 5 MINUTE) AS bucket,
  tool_name,
  sum(is_error) AS error_count,
  count() AS total_calls,
  round(sum(duration_ms) / count(), 2) AS avg_duration_ms
FROM studio_monitoring_logs
WHERE organization_id = '<your-org>'
  AND timestamp >= now() - INTERVAL 2 HOUR
  AND connection_title ILIKE '%otica-isabela%'
GROUP BY bucket, tool_name
ORDER BY bucket DESC, error_count DESC;
```

### Step 6: Record Your Findings

```
Call: RESPOND_TO_EVENT with:
  target="service-id-57" (or event ref from the trigger)
  outcome="investigating" (or "expected" / "fixed" / "watching")
  note="p95 latency rose 2.5x at 14:22 UTC; correlated with OOM kill on pod-2; already recovered"
  details="<markdown with evidence and what you ruled out>"
```

---

## Troubleshooting

### "ClickHouse connection refused"
- Verify `CLICKHOUSE_URL` env var is set in Studio deployment
- Confirm `studio_monitoring_logs` view exists: `DESCRIBE TABLE studio_monitoring_logs`
- Check that the exporter has populated `otel_logs` with data (row count > 0)

### "raw_cloudflare table not found"
- This table is part of the ClickStack / CDN Stats Lake, not the Studio app
- It is accessed via the `apnjvob_*` tools (not directly from Studio)
- If you're querying ClickHouse directly, use the `CLICKHOUSE_QUERY` tool with proper `ClientRequestHost` filtering

### "Service ID 57 has no data in Grafana"
- The service may be inactive / de-provisioned
- Call `MONITORED_NAMESPACES` to verify the site is still being watched
- Cross-check with `SERVICE_DETAIL` response (may return zero metrics if the service never had traffic)

---

## Key Takeaways

| What | Tool/File |
|------|-----------|
| **Verify ClickHouse is wired** | Query `studio_monitoring_logs` (check row count) |
| **Check site health (Grafana)** | `GRAFANA_SITE_DETAIL` |
| **Check service health** | `SERVICE_DETAIL` with service name or ID |
| **Check CDN metrics** | `CDN_DAILY_OVERVIEW`, `CDN_TOP_URLS_DAILY` |
| **Check raw CDN requests** | `CDN_RAW_REQUESTS` (2-day retention) |
| **Audit tool execution** | Query `studio_monitoring_logs` directly via `CLICKHOUSE_QUERY` |
| **Record investigation** | `RESPOND_TO_EVENT` + `INVESTIGATE_ERROR` |

---

## Example: Full Investigation Script

```typescript
// Pseudocode — you do this via the agent's subtask calls

async function investigateLatencySpike(siteId: string, minutes: number = 60) {
  // 1. Get service context
  const service = await SERVICE_DETAIL({ service: siteId });
  console.log(`Service ${siteId}: p95=${service.p95Ms}ms, errorRate=${service.errorRate5xx}`);
  
  // 2. Get pod status
  const pods = await GRAFANA_SITE_PODS({ site: siteId, windowSec: minutes * 60 });
  const unhealthyPods = pods.filter(p => p.phase !== "Running");
  console.log(`Unhealthy pods: ${unhealthyPods.length}`);
  
  // 3. Get events (restarts, OOMs, etc.)
  const events = await GRAFANA_RECENT_EVENTS({ namespace: siteId, windowMin: minutes });
  const crashes = events.filter(e => e.type === "restart" && e.count > 3);
  console.log(`Crash events: ${crashes.length}`);
  
  // 4. If CDN-visible, check cache
  const cdnOverview = await CDN_DAILY_OVERVIEW({ siteIds: [service.serviceId] });
  console.log(`Cache hit rate: ${cdnOverview.cacheHitRate}%`);
  
  // 5. Drill into errors
  const topErrors = await LIST_TOP_ERRORS({ lastMinutes: minutes });
  console.log(`Top errors: ${topErrors.length}`);
  
  // 6. Record verdict
  const verdict = crashes.length > 0 ? "watching" : "investigating";
  await RESPOND_TO_EVENT({
    target: siteId,
    outcome: verdict,
    note: `Investigated ${minutes}m window; ${crashes.length} crash events, p95=${service.p95Ms}ms`,
  });
}
```

---

## Files to Keep Handy

1. **ClickHouse Setup**: `/app/repo/apps/mesh/src/monitoring/clickhouse-setup.md`
   - View DDL, schema contract, scaling notes
2. **SQL Queries**: `/app/repo/apps/mesh/src/storage/monitoring-sql.ts`
   - Templated queries used by the dashboard; easy reference
3. **Schema**: `/app/repo/apps/mesh/src/monitoring/schema.ts`
   - Attribute keys, type definitions, row conversion
