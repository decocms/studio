# Investigation Tools & Infrastructure — Complete Index

## TL;DR

You have **three comprehensive reference documents** covering investigation tools, ClickHouse connections, and monitoring infrastructure:

| Document | Purpose | Best For |
|----------|---------|----------|
| **investigation-tools-summary.txt** | Authoritative master inventory (24KB) | Complete reference; grep-friendly |
| **investigation-tools-inventory.md** | Detailed markdown guide (13KB) | Deep reading; schema walkthroughs |
| **investigation-quick-reference.md** | Quick-start checklists (8KB) | In-the-moment investigations |

---

## What You Found

### ClickHouse Stats Lake Connection
- **ID**: `conn_la7-Xv8sU9RrenfUmiPIf` (Stats Lake)
- **View**: `studio_monitoring_logs` (OTel-based tool execution logs)
- **Location**: decocms/studio repository (`/app/repo/apps/mesh/src/monitoring/`)
- **Scope**: Multi-tenant (scoped by `organization_id` on every query)

### Investigation Tools (Agent Platform)
40+ tools provided in your agent context for:
- Service & site health (SERVICE_DETAIL, GRAFANA_*)
- Application errors (ERROR_DETAIL, SEARCH_ERRORS)
- CDN metrics (CDN_DAILY_OVERVIEW, CDN_RAW_REQUESTS)
- OTel logs (SEARCH_EVENTS, SEARCH_ERRORS)
- Alert quality & threshold tuning
- Investigation recording & history

### Available ClickHouse Tables
- `studio_monitoring_logs` — Studio's tool execution (OTel view)
- `otel_logs` — Application logs (all services)
- `otel_traces` — Distributed tracing
- `raw_cloudflare` — CDN edge requests (partitioned by host + timestamp)
- `raw_cloudflare_firewall` — WAF events

---

## Key Files in decocms/studio

All files are under `/app/repo/apps/mesh/src/`:

| File | Lines | Purpose |
|------|-------|---------|
| `monitoring/clickhouse-setup.md` | 174 | **Start here**: Manual ClickHouse provisioning, view DDL, tuning |
| `monitoring/schema.ts` | 191 | OTel attribute keys, MonitoringRow type, conversion funcs |
| `monitoring/query-engine.ts` | 443 | QueryEngine interface, DuckDB + ClickHouse implementations |
| `storage/monitoring-sql.ts` | 2201 | Dashboard SQL queries (safe bucketing, aggregation, validation) |
| `observability/index.ts` | 709 | OTel setup, exporters, samplers, MONITORING_SPAN_NAME |

---

## How to Query for `sites-otica-isabela` / Service ID 57

### Step 1: Get Service Context
```
Call: SERVICE_DETAIL(service="sites-otica-isabela" or serviceId=57)
Result: p95Ms, errorRate, requestRate, topErrors, pod health
```

### Step 2: Drill Into Infrastructure  
```
Call: GRAFANA_SITE_DETAIL(site="otica-isabela", windowSec=600)
Result: Pod readiness, restarts, OOMs, CPU/mem vs request
```

### Step 3: Check CDN Layer
```
Call: CDN_DAILY_OVERVIEW(siteIds=[<from-step-1>])
Result: Cache hit rate, 4xx/5xx counts, traffic, error rate
```

### Step 4: If Spike is Real, Query ClickHouse
```sql
-- CDN latency p95 (raw_cloudflare, partitioned by host + timestamp)
SELECT
  toStartOfMinute(EdgeEndTimestamp) AS bucket,
  Status,
  quantile(0.95)(Upstream.latency) AS p95_ms,
  count() AS requests
FROM raw_cloudflare
WHERE ClientRequestHost = 'sites-otica-isabela.com'
  AND EdgeEndTimestamp >= now() - INTERVAL 1 HOUR
GROUP BY bucket, Status
ORDER BY bucket DESC;
```

### Step 5: Record Findings
```
Call: RESPOND_TO_EVENT(target="57", outcome="watching", note="...", details="...")
```

---

## Checklists for Common Tasks

### Investigate Latency Spike  
→ See **investigation-quick-reference.md** Section 7

### Query ClickHouse Directly  
→ See **investigation-tools-summary.txt** Section 5 (table schemas + examples)

### Understand ClickHouse Setup  
→ See **investigation-tools-inventory.md** Section 4 (view DDL + prerequisites)

### List All Investigation Tools  
→ See **investigation-tools-summary.txt** Section 4 (organized by category)

---

## Key Constraints & Tips

1. **raw_cloudflare filtering** (critical for performance):
   - ALWAYS filter by exact `ClientRequestHost = 'value'` (no LIKE)
   - ALWAYS filter by `EdgeEndTimestamp` range (not just date)
   - This table scans billions of rows; incorrect filters will timeout

2. **Tenant scoping**:
   - All queries filter by `organization_id` (Studio) or `ServiceName` (OTel)
   - Multi-tenant isolation is built-in

3. **Time anchoring**:
   - Call `GET_CURRENT_TIMESTAMP()` to get server time
   - Don't rely on your local clock for investigation windows

4. **Investigation recording**:
   - Use `RESPOND_TO_EVENT` to record verdicts on trigger events
   - Use `INVESTIGATE_ERROR` to dive deep into errors + record findings
   - This builds an audit trail for alert-quality grading

---

## File Locations (in decocms/studio)

```
/app/repo/
├── apps/mesh/src/
│   ├── monitoring/
│   │   ├── clickhouse-setup.md          ← START HERE
│   │   ├── schema.ts                     ← OTel attributes
│   │   ├── query-engine.ts               ← QueryEngine interface
│   │   ├── query-engine.test.ts          ← Examples
│   │   └── ... (exporters, converters)
│   ├── storage/
│   │   ├── monitoring-sql.ts             ← Dashboard queries
│   │   └── ... (storage implementations)
│   └── observability/
│       └── index.ts                      ← OTel setup
├── .deco/tools/.endpoint.json            ← Studio MCP endpoint
└── ... (other packages)
```

---

## Investigation Tools (Quick Reference)

**Service & Site Health**
- `SERVICE_DETAIL(service)` → Grafana metrics + errors
- `GRAFANA_SITE_DETAIL(site)` → Pod health, restarts, OOMs
- `GRAFANA_TIMESERIES(metric)` → Historical metric series
- `GRAFANA_RECENT_EVENTS(namespace)` → K8s state changes

**Errors**
- `LIST_TOP_ERRORS(lastMinutes)` → Top errors in window
- `ERROR_DETAIL(errorId)` → Full error drill-down
- `SEARCH_ERRORS(query)` → Substring match
- `INVESTIGATE_ERROR(errorId)` → Record investigation

**CDN**
- `CDN_DAILY_OVERVIEW(siteIds)` → Daily CDN stats
- `CDN_RAW_REQUESTS(hosts)` → Per-request rows (2-day retention)
- `CDN_RAW_FIREWALL(hosts)` → WAF events

**Logs**
- `SEARCH_EVENTS(source, q)` → Free-text search in otel_logs/traces
- `SEARCH_HISTOGRAM(source, q)` → Time-bucketed event counts

**Raw Queries**
- `CLICKHOUSE_QUERY(sql)` → Raw SQL against ClickHouse
- `GRAFANA_QUERY_PROMQL(expr)` → PromQL against Prometheus

**Alert Quality**
- `ALERT_QUALITY(days)` → Grade alerts against outcomes
- `APPLY_THRESHOLD_RECOMMENDATION(...)` → Apply threshold tuning

**Investigation History**
- `GET_INVESTIGATION(id)` → Read investigation findings
- `LIST_INVESTIGATIONS(status)` → List all investigations
- `RECORD_INVESTIGATION_FEEDBACK(...)` → Append findings
- `RESPOND_TO_EVENT(target, outcome)` → Record verdict on trigger

---

## Next Steps

1. **Read** `investigation-tools-inventory.md` for the full context (~20 min)
2. **Bookmark** `investigation-tools-summary.txt` for grep/reference (~5 min per lookup)
3. **Use** `investigation-quick-reference.md` when responding to alerts (~2 min per check)
4. **Verify** the ClickHouse view exists:
   ```sql
   DESCRIBE TABLE studio_monitoring_logs;
   ```
5. **Test** a simple query:
   ```sql
   SELECT count() FROM studio_monitoring_logs 
   WHERE timestamp >= now() - INTERVAL 1 HOUR;
   ```

---

## Questions?

- **ClickHouse schema**: `/app/repo/apps/mesh/src/monitoring/clickhouse-setup.md`
- **Query engine**: `/app/repo/apps/mesh/src/monitoring/query-engine.ts`
- **Dashboard queries**: `/app/repo/apps/mesh/src/storage/monitoring-sql.ts`
- **Tools**: See Section 4 of `investigation-tools-summary.txt`

---

**Generated**: 2026-07-23  
**Repository**: decocms/studio (loaded from connectionId `conn_viS0AjFZ1cffE5x13DQU_`)  
**ClickHouse Connection**: `conn_la7-Xv8sU9RrenfUmiPIf` (Stats Lake)
