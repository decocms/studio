# Infrastructure Architecture Design

**Date**: 2026-03-05
**Status**: Draft
**Authors**: Architecture brainstorm session

## Abstract

MCP Mesh is a control plane for Model Context Protocol traffic that must run in two very different environments: **deployed to our cloud** as a multi-pod Kubernetes service, and **locally on any developer's Mac or Linux machine** via a single `npx decocms` command with zero setup. Today these two modes are served by different technology stacks — SQLite for local storage vs PostgreSQL for cloud, optional NATS for distributed coordination, OpenTelemetry for ops tracing alongside a separate `monitoring_logs` database table for the product dashboard, and no unified blob or log storage strategy. This split creates real problems: features that work on PostgreSQL break on SQLite (different JSON operators, date functions, boolean types), monitoring data bloats the main relational database, and the local experience carries unnecessary complexity.

This document proposes a unified infrastructure architecture that collapses these divergences. The core idea is that **the same code runs everywhere**, with only the underlying drivers and export targets changing between environments:

- **One SQL dialect (PostgreSQL)** by using PGlite — PostgreSQL compiled to WebAssembly — for local, and native PostgreSQL for cloud. This eliminates the dual-dialect problem entirely. Kysely remains the query builder; only the driver changes.

- **One monitoring pipeline (OpenTelemetry)** that feeds into Parquet files queryable by DuckDB. Locally, a thin in-process exporter writes Parquet to disk. In cloud, the standard OTLP exporter sends data to an OTel Collector sidecar that writes Parquet to S3 (for the product dashboard) and forwards to Grafana (for SRE ops). DuckDB reads Parquet in both cases — local files or S3 — through the same query interface. This replaces the current split of OTel-for-ops plus database-for-dashboards with a single system.

- **NATS stays as-is** for cross-pod coordination in cloud (event bus, stream buffering, SSE fan-out), with polling as the local fallback. No changes needed here.

The local deployment becomes a single process with two embedded engines (PGlite + DuckDB) and no external services. The cloud deployment remains stateless pods backed by PostgreSQL, NATS, S3, and OTel Collector. The application code doesn't branch on environment — it branches on which driver is injected at startup.

## Goals

1. **Single SQL dialect** — eliminate SQLite/PostgreSQL divergence by using PostgreSQL everywhere
2. **Unified monitoring** — one instrumentation system (OpenTelemetry) with Parquet/DuckDB for dashboard analytics
3. **Zero-dependency local setup** — everything runs under a single `npx decocms` command with no external services
4. **Cloud-native scaling** — stateless pods backed by PostgreSQL, S3, NATS, and OTel Collector

## Architecture Overview

```
LOCAL (npx decocms)                    CLOUD (Kubernetes)
┌─────────────────────────┐            ┌─────────────────────────────────────┐
│  Single Process          │            │  Per Pod                            │
│                          │            │                                     │
│  ┌──────────────────┐   │            │  ┌──────────────────┐               │
│  │  MCP Mesh Server  │   │            │  │  MCP Mesh Server  │               │
│  │                    │   │            │  │                    │               │
│  │  OTel SDK          │   │            │  │  OTel SDK          │               │
│  │  ├─ ParquetExporter│   │            │  │  └─ OTLPExporter ──┼──► Collector │
│  │  │  (in-process)   │   │            │  │                    │    ├► S3      │
│  │  │                 │   │            │  │                    │    └► Grafana │
│  │  ▼                 │   │            │  │                    │               │
│  │  ./data/monitoring/│   │            │  └──────────────────┘               │
│  │  *.parquet         │   │            │                                     │
│  │                    │   │            │  Shared Services:                   │
│  │  PGlite (in-proc) │   │            │  ├─ PostgreSQL (managed)            │
│  │  ./data/mesh.pglite│   │            │  ├─ NATS (cross-pod coordination)  │
│  │                    │   │            │  ├─ S3 (monitoring Parquet + blobs) │
│  │  DuckDB (in-proc) │   │            │  └─ OTel Collector (sidecar)       │
│  │  (reads Parquet)   │   │            │                                     │
│  └──────────────────┘   │            │  DuckDB (in each pod, reads S3)     │
└─────────────────────────┘            └─────────────────────────────────────┘
```

---

## 1. Database Layer

### Decision

**PGlite locally + PostgreSQL in cloud.** Drop SQLite support entirely.

### Local

- **PGlite** (`@electric-sql/pglite`, ~10MB) — PostgreSQL compiled to WASM
- Runs in-process, no server, no external binary
- File-based storage at `./data/mesh.pglite/`
- Full PostgreSQL SQL compatibility (JSONB, arrays, CTEs, date functions)
- Single-connection (acceptable for single-process local)

### Cloud

- Standard PostgreSQL (managed instance, e.g., RDS, Cloud SQL, Neon)
- Multi-connection via `pg.Pool` (existing implementation)
- LISTEN/NOTIFY available for event bus notifications

### What Changes

| Before | After |
|--------|-------|
| Dual dialect: SQLite `json_extract()` + PostgreSQL `::jsonb #>>` | One dialect: PostgreSQL everywhere |
| `kysely-bun-worker` for SQLite | `@electric-sql/pglite` for local |
| Dialect branching in storage code | Single code path |
| Risk of SQLite/PostgreSQL divergence | Eliminated |

### Migration Path

1. Replace `kysely-bun-worker` SQLite adapter with PGlite adapter in database factory
2. Remove all SQLite-specific code paths (JSON extraction, time bucketing, boolean handling)
3. Keep Kysely as the query builder — only the dialect/driver changes
4. Run existing Kysely + Better Auth migrations against PGlite (they should work as-is since they'll target PostgreSQL dialect)
5. Update `DATABASE_URL` detection: `file://` or absent → PGlite, `postgres://` → native PostgreSQL

### Risks

- **PGlite maturity**: Less battle-tested than SQLite for server-side Node.js/Bun usage
- **Bun WASM compatibility**: PGlite targets Node.js; Bun WASM support may have edge cases
- **Memory footprint**: PostgreSQL engine in WASM uses more memory than SQLite
- **Fallback plan**: If PGlite has issues, users can install PostgreSQL locally and set `DATABASE_URL=postgres://...`

---

## 2. Message Passing (NATS)

### Decision

**No changes.** Current NATS architecture is well-designed.

### Current State (Preserved)

NATS is optional, used for cross-pod coordination in cloud:

| Use Case | NATS Subject | Pattern |
|----------|-------------|---------|
| Event bus wake-up | `mesh.events.notify` | Core pub/sub |
| Decopilot stream buffering | `decopilot.stream.{threadId}` | JetStream (memory) |
| Run cancellation | `mesh.decopilot.cancel` | Core pub/sub |
| SSE broadcasting | `mesh.sse.broadcast` | Core pub/sub |

### Strategy Selection

| Environment | Notify Strategy |
|-------------|----------------|
| Local (PGlite) | Polling (PGlite doesn't support LISTEN/NOTIFY) |
| Cloud without NATS | PostgreSQL LISTEN/NOTIFY |
| Cloud with NATS | NATS (preferred) + polling fallback |

Controlled by `NATS_URL` and `NOTIFY_STRATEGY` environment variables (existing behavior).

---

## 3. Monitoring & Observability

### Decision

**Unified OTel instrumentation + Parquet files + DuckDB for dashboard queries.**

This replaces the current dual system (OTel for ops + `monitoring_logs` table for dashboards) with a single pipeline.

### Architecture

```
Tool Call Execution
       │
       ▼
MonitoringTransport enriches OTel span
  (tool name, input, output, duration, user, connection, properties)
       │
       ▼
OTel SDK SpanExporter
       │
       ├── LOCAL: ParquetSpanExporter (in-process)
       │     └─ Writes to ./data/monitoring/YYYY/MM/DD/HH/batch-NNN.parquet
       │
       └── CLOUD: OTLPTraceExporter (standard)
              └─ OTel Collector sidecar
                    ├─ Pipeline 1: Parquet on S3 (s3://bucket/monitoring/...)
                    └─ Pipeline 2: Grafana/OTLP backend (for SRE dashboards)

Dashboard UI queries
       │
       ▼
DuckDBMonitoringStorage
       │
       ├── LOCAL: read_parquet('./data/monitoring/**/*.parquet')
       └── CLOUD: read_parquet('s3://bucket/monitoring/**/*.parquet')
```

### What Gets Removed

- `monitoring_logs` table (migration to drop it)
- `SqlMonitoringStorage` class
- Direct database writes from `MonitoringTransport`
- PII redaction before DB storage (moves to span attribute redaction)

### What Gets Added

#### ParquetSpanExporter (~150-200 lines)

Custom OTel `SpanExporter` for local use:
- Implements `export(spans: ReadableSpan[]): Promise<ExportResult>`
- Buffers spans in memory (flush threshold: 1000 spans or 60 seconds)
- On flush: writes Parquet file via DuckDB's `COPY` command or `parquet-wasm`
- File naming: `./data/monitoring/YYYY/MM/DD/HH/batch-{counter}.parquet`
- Time-partitioned for efficient range queries

#### DuckDBMonitoringStorage

Implements the existing `MonitoringStorage` interface + aggregate methods:

| Method | DuckDB Query Pattern |
|--------|---------------------|
| `query(filters)` | `SELECT * FROM read_parquet(path) WHERE ... ORDER BY timestamp DESC LIMIT N` |
| `getStats(filters)` | `SELECT count(*), avg(duration_ms), sum(is_error)::float/count(*) FROM ...` |
| `aggregate(params)` | `SELECT date_trunc(interval, timestamp), agg(json_extract(output, path)) FROM ... GROUP BY 1` |
| `countMatched(params)` | `SELECT count(*) FROM ... WHERE json_extract(output, path) IS NOT NULL` |

DuckDB advantages over current approach:
- **One SQL dialect** for all monitoring queries (vs current SQLite + PostgreSQL branching)
- **Columnar storage** — aggregations are 10-100x faster on large datasets
- **Native Parquet support** — no ETL, just `read_parquet()` with glob patterns
- **Native S3 support** — reads S3 Parquet files transparently with `httpfs` extension

#### Span Enrichment

The `MonitoringTransport` changes from:
```typescript
// Before: write to database
await ctx.storage.monitoring.log({ toolName, input, output, ... });
```

To:
```typescript
// After: enrich OTel span
span.setAttribute("mesh.tool.name", toolName);
span.setAttribute("mesh.tool.input", JSON.stringify(redact(input)));
span.setAttribute("mesh.tool.output", JSON.stringify(redact(output)));
span.setAttribute("mesh.tool.duration_ms", durationMs);
span.setAttribute("mesh.tool.is_error", isError);
span.setAttribute("mesh.connection.id", connectionId);
// ... etc
```

### What Stays Unchanged

- **Dashboard UI** — Zero changes. Calls same MCP tools, gets same response shapes.
- **MCP monitoring tools** — `MONITORING_LOGS_LIST`, `MONITORING_STATS`, `MONITORING_DASHBOARD_QUERY`, `MONITORING_WIDGET_PREVIEW` — same interfaces, new storage backend.
- **`monitoring_dashboards` table** — Stays in main PGlite/PostgreSQL database (small relational metadata for dashboard widget definitions).
- **Prometheus `/metrics` endpoint** — Continues to work via existing OTel PrometheusExporter.
- **PII redaction** — Same `RegexRedactor`, applied to span attributes before export instead of before DB storage.

### Parquet Schema

```
monitoring span parquet columns:
├── id: VARCHAR (span ID)
├── organization_id: VARCHAR
├── connection_id: VARCHAR
├── connection_title: VARCHAR
├── tool_name: VARCHAR
├── input: VARCHAR (JSON string, redacted)
├── output: VARCHAR (JSON string, redacted)
├── is_error: BOOLEAN
├── error_message: VARCHAR (nullable)
├── duration_ms: INTEGER
├── timestamp: TIMESTAMP
├── user_id: VARCHAR (nullable)
├── request_id: VARCHAR
├── user_agent: VARCHAR (nullable)
├── virtual_mcp_id: VARCHAR (nullable)
├── properties: VARCHAR (JSON string, nullable)
```

### Retention

- **Local**: Configurable cleanup (e.g., delete Parquet files older than 30 days via a periodic task)
- **Cloud**: S3 lifecycle rules (move to Glacier after 30 days, delete after 90 — configurable per deployment)

---

## 4. Deployment Model

### Local (`npx decocms`)

**Single process, zero external dependencies.**

| Component | Technology | Location |
|-----------|-----------|----------|
| Relational DB | PGlite (in-process WASM) | `./data/mesh.pglite/` |
| Monitoring writes | ParquetSpanExporter (in-process) | `./data/monitoring/*.parquet` |
| Monitoring queries | DuckDB (in-process native) | reads `./data/monitoring/` |
| Message passing | Polling strategy | in-process timer |
| OTel export | None (local Parquet only) | — |

**npm package additions:**

| Package | Purpose | Approx Size |
|---------|---------|-------------|
| `@electric-sql/pglite` | PostgreSQL (WASM) | ~10MB |
| `duckdb` | Analytics queries (native binary) | ~15MB |

**npm package removals:**

| Package | Reason |
|---------|--------|
| `kysely-bun-worker` | SQLite removed |

### Cloud (Kubernetes)

**Stateless pods, shared services.**

| Component | Technology | Notes |
|-----------|-----------|-------|
| Relational DB | PostgreSQL (managed) | Existing setup |
| Monitoring writes | OTLP → OTel Collector → S3 Parquet | Collector is a sidecar |
| Monitoring queries | DuckDB (in-pod, reads S3) | `httpfs` extension for S3 |
| SRE dashboards | OTel Collector → Grafana | Second collector pipeline |
| Message passing | NATS | Existing setup |
| Prometheus metrics | `/metrics` endpoint | Existing setup |

### Environment Detection

```typescript
function createInfrastructure(env: ProcessEnv) {
  const dbUrl = env.DATABASE_URL;

  // Database
  const db = dbUrl?.startsWith("postgres")
    ? createPostgresDatabase(dbUrl)
    : createPGliteDatabase("./data/mesh.pglite");

  // Monitoring
  const monitoringBasePath = env.MONITORING_PARQUET_PATH ?? "./data/monitoring";
  const monitoringStorage = new DuckDBMonitoringStorage(monitoringBasePath);

  // OTel span exporter
  const spanExporter = env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OTLPTraceExporter()              // Cloud: send to collector
    : new ParquetSpanExporter(monitoringBasePath); // Local: write Parquet

  // Notify strategy
  const notifyStrategy = env.NATS_URL
    ? new NatsNotifyStrategy(nats)
    : db.type === "postgres"
      ? new PostgresNotifyStrategy(db.pool)
      : new PollingStrategy(5000);

  return { db, monitoringStorage, spanExporter, notifyStrategy };
}
```

---

## 5. Summary of Decisions

| Concern | Local | Cloud |
|---------|-------|-------|
| **Relational DB** | PGlite (in-process WASM) | PostgreSQL (managed) |
| **SQL Dialect** | PostgreSQL (via PGlite) | PostgreSQL (native) |
| **Monitoring writes** | ParquetSpanExporter (in-process) | OTLP → Collector → S3 Parquet |
| **Monitoring queries** | DuckDB → local Parquet | DuckDB → S3 Parquet |
| **SRE observability** | N/A | Collector → Grafana |
| **Message passing** | Polling | NATS |
| **Prometheus metrics** | `/metrics` endpoint | `/metrics` endpoint |
| **External processes** | None | PostgreSQL, NATS, OTel Collector |

---

## 6. New Dependencies

| Dependency | Type | Purpose |
|-----------|------|---------|
| `@electric-sql/pglite` | npm (WASM) | Local PostgreSQL |
| `duckdb` | npm (native binary) | Monitoring analytics |

## 7. Removed Dependencies

| Dependency | Reason |
|-----------|--------|
| `kysely-bun-worker` | SQLite support removed |
| `better-sqlite3` (if used) | SQLite support removed |

## 8. Migration Risks

| Risk | Mitigation |
|------|-----------|
| PGlite immaturity in Bun | Test early; fallback is `DATABASE_URL=postgres://localhost` |
| DuckDB native binary platform support | Covers Mac (arm64/x64) + Linux (x64/arm64); Windows via WSL |
| OTel span attribute size limits | Truncate large input/output at application level (e.g., 50KB cap) |
| Parquet write latency on flush | Buffer in memory, flush async — doesn't block tool execution |
| S3 query latency for dashboards | DuckDB caches Parquet metadata; time partitioning limits scanned files |
| Existing monitoring_logs data migration | Export to Parquet as a one-time migration, or accept data loss for historical logs |
