# Org-Sharded Paths + DuckDB Monitoring Backend

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Shard NDJSON exports by `organization_id` in the file path and replace chdb with `@duckdb/node-api` for local monitoring queries.

**Architecture:** The NDJSON exporter gains org-aware path partitioning (`basePath/<org_id>/YYYY/MM/DD/HH/*.ndjson`). The query engine swaps chdb for DuckDB's native Node-API binding, using `read_ndjson('.../<org_id>/**/*.ndjson')` for filesystem-level partition pruning. Cloud continues using `@clickhouse/client` unchanged. The `NDJSONExporter` groups buffered rows by a partition key before flushing, writing each group to its own org subdirectory.

**Tech Stack:** `@duckdb/node-api` (native N-API, works on Bun >= 1.2.2), existing `@clickhouse/client`, Bun test runner.

**Key design decision — `@duckdb/node-api` vs `@duckdb/duckdb-wasm`:** We use the native binding (`@duckdb/node-api`). It is faster, simpler (no WASM bundle/worker setup), has full DuckDB feature parity, and works on Bun since v1.2.2. No WASM files to ship in the server bundle.

---

## File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `apps/mesh/src/monitoring/ndjson-exporter.ts` | Modify | Add partition-key support to group rows before flush |
| `apps/mesh/src/monitoring/ndjson-exporter.test.ts` | Modify | Add tests for partitioned output |
| `apps/mesh/src/monitoring/ndjson-log-exporter.ts` | Modify | Extract `organization_id` as partition key |
| `apps/mesh/src/monitoring/ndjson-metric-exporter.ts` | Modify | Extract `organization_id` as partition key |
| `apps/mesh/src/monitoring/query-engine.ts` | Modify | Replace `ChdbEngine` with `DuckDBEngine`, update `createMonitoringEngine` to accept `organizationId` |
| `apps/mesh/src/monitoring/query-engine.test.ts` | Modify | Replace chdb tests with DuckDB tests |
| `apps/mesh/src/monitoring/ndjson-retention.ts` | Modify | Walk org subdirectories in retention cleanup |
| `apps/mesh/src/monitoring/ndjson-retention.test.ts` | Modify | Add tests for org-sharded directory structure |
| `apps/mesh/src/monitoring/schema.ts` | No change | Types/constants unchanged |
| `apps/mesh/src/storage/monitoring-clickhouse.ts` | Modify | Accept `organizationId` for source expression construction |
| `apps/mesh/src/storage/monitoring-clickhouse.test.ts` | Modify | Update to use DuckDB engine |
| `apps/mesh/src/core/context-factory.ts` | Modify | Pass `organizationId` to engine factory (lazy/per-request) |
| `apps/mesh/package.json` | Modify | Replace `chdb` with `@duckdb/node-api` in optionalDependencies |
| `package.json` (root) | Modify | Update `trustedDependencies` |
| `apps/mesh/src/monitoring/test-utils.ts` | Modify | Add helper for org-sharded test directories |

---

## Task 1: Add partition-key support to `NDJSONExporter`

The core exporter currently writes all buffered rows to one directory. We add a `partitionKey` extractor so rows are grouped by partition before flush, each group written to `basePath/<partitionKey>/YYYY/MM/DD/HH/`.

**Files:**
- Modify: `apps/mesh/src/monitoring/ndjson-exporter.ts`
- Modify: `apps/mesh/src/monitoring/ndjson-exporter.test.ts`

### Step 1: Write the failing test for partitioned output

Add a new test to `ndjson-exporter.test.ts`:

```typescript
it("should partition rows by key into separate subdirectories", async () => {
  const partitioned = new NDJSONExporter<TestRow & { org: string }>({
    basePath: tmpDir,
    flushThreshold: 4,
    flushIntervalMs: 60_000,
    partitionKey: (row) => row.org,
  });

  const rows = [
    { v: 1 as const, id: "1", value: "a", org: "org_a" },
    { v: 1 as const, id: "2", value: "b", org: "org_b" },
    { v: 1 as const, id: "3", value: "c", org: "org_a" },
    { v: 1 as const, id: "4", value: "d", org: "org_b" },
  ];

  const result = await partitioned.exportRows(rows);
  expect(result.code).toBe(ExportResultCode.SUCCESS);

  const files = await findNDJSONFiles(tmpDir);
  expect(files.length).toBe(2); // one per org

  // Verify org_a file is under org_a subdirectory
  const orgAFiles = files.filter((f) => f.includes("/org_a/"));
  const orgBFiles = files.filter((f) => f.includes("/org_b/"));
  expect(orgAFiles.length).toBe(1);
  expect(orgBFiles.length).toBe(1);

  const orgAContent = await readFile(orgAFiles[0]!, "utf-8");
  const orgALines = orgAContent.trim().split("\n").map((l) => JSON.parse(l));
  expect(orgALines.length).toBe(2);
  expect(orgALines.every((r: any) => r.org === "org_a")).toBe(true);

  await partitioned.shutdown();
});
```

Also add a test that the existing non-partitioned behavior still works (no `partitionKey` option = writes to basePath directly as before).

### Step 2: Run the test, verify it fails

```bash
bun test apps/mesh/src/monitoring/ndjson-exporter.test.ts
```

Expected: Fails because `partitionKey` option doesn't exist yet.

### Step 3: Implement partitioned flush in `NDJSONExporter`

In `ndjson-exporter.ts`:

1. Add `partitionKey` to `NDJSONExporterOptions`:

```typescript
export interface NDJSONExporterOptions<T = unknown> {
  basePath: string;
  flushThreshold?: number;
  flushIntervalMs?: number;
  maxBufferBytes?: number;
  partitionKey?: (row: T) => string;
}
```

2. Store the extractor in the constructor:

```typescript
private partitionKey: ((row: T) => string) | undefined;

constructor(options: NDJSONExporterOptions<T>) {
  // ... existing code ...
  this.partitionKey = options.partitionKey;
}
```

3. Change `exportRows` to store raw rows alongside strings (we need the row to extract partition key at flush time). **Simpler approach:** extract partition keys at export time and store `{ partition: string; json: string }[]` instead of `string[]`:

```typescript
private buffer: Array<{ partition: string; json: string }> = [];

exportRows(rows: T[]): Promise<ExportResult> {
  if (this.isShutdown) {
    return Promise.resolve({ code: ExportResultCode.FAILED });
  }

  for (const row of rows) {
    const json = JSON.stringify(row);
    const partition = this.partitionKey ? this.partitionKey(row) : "";
    this.buffer.push({ partition, json });
    this.bufferBytes += Buffer.byteLength(json, "utf8") + 1;
  }

  // ... threshold check unchanged ...
}
```

4. Change `doFlush` to group by partition:

```typescript
private async doFlush(): Promise<void> {
  if (this.buffer.length === 0) return;

  const items = this.buffer;
  this.buffer = [];
  this.bufferBytes = 0;

  try {
    // Group by partition
    const groups = new Map<string, string[]>();
    for (const { partition, json } of items) {
      let arr = groups.get(partition);
      if (!arr) {
        arr = [];
        groups.set(partition, arr);
      }
      arr.push(json);
    }

    // Write each group
    const writes: Promise<void>[] = [];
    for (const [partition, strings] of groups) {
      writes.push(this.writeNDJSON(strings, partition));
    }
    await Promise.all(writes);
  } catch (err) {
    // Restore buffer on failure
    this.buffer = items.concat(this.buffer);
    this.bufferBytes = 0;
    for (const { json } of this.buffer) {
      this.bufferBytes += Buffer.byteLength(json, "utf8") + 1;
    }
    throw err;
  }
}
```

5. Update `writeNDJSON` to insert partition in the path:

```typescript
private async writeNDJSON(strings: string[], partition: string): Promise<void> {
  const now = new Date();
  const timeParts = [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
  ];

  // If partition is non-empty, insert it between basePath and date dirs
  const dir = partition
    ? join(this.basePath, partition, ...timeParts)
    : join(this.basePath, ...timeParts);

  if (!this.knownDirs.has(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    this.knownDirs.add(dir);
  }

  const filename = `${crypto.randomUUID()}.ndjson`;
  const tmpPath = join(dir, `.${filename}.tmp`);
  const finalPath = join(dir, filename);

  const content = strings.join("\n") + "\n";
  await writeFile(tmpPath, content, { mode: 0o600 });
  await rename(tmpPath, finalPath);
}
```

### Step 4: Run the tests, verify they pass

```bash
bun test apps/mesh/src/monitoring/ndjson-exporter.test.ts
```

Expected: All pass (both old non-partitioned tests and new partitioned test).

### Step 5: Commit

```bash
git add apps/mesh/src/monitoring/ndjson-exporter.ts apps/mesh/src/monitoring/ndjson-exporter.test.ts
git commit -m "feat(monitoring): add partition-key support to NDJSONExporter"
```

---

## Task 2: Wire org_id partition into log and metric exporters

**Files:**
- Modify: `apps/mesh/src/monitoring/ndjson-log-exporter.ts`
- Modify: `apps/mesh/src/monitoring/ndjson-metric-exporter.ts`

### Step 1: Update `NDJSONLogExporter` to pass partition key

In `ndjson-log-exporter.ts`, change the constructor to pass a `partitionKey` extractor that reads `organization_id` from each `MonitoringRow`:

```typescript
constructor(options: NDJSONLogExporterOptions) {
  this.inner = new NDJSONExporter<MonitoringRow>({
    ...options,
    partitionKey: (row) => row.organization_id,
  });
}
```

That's the entire change. The `MonitoringRow` already has `organization_id` as a field.

### Step 2: Update `NDJSONMetricExporter` similarly

In `ndjson-metric-exporter.ts`:

```typescript
constructor(options: NDJSONMetricExporterOptions) {
  this.inner = new NDJSONExporter<MetricRow>({
    ...options,
    partitionKey: (row) => row.organization_id,
  });
}
```

### Step 3: Run existing exporter tests

```bash
bun test apps/mesh/src/monitoring/ndjson-log-exporter.test.ts apps/mesh/src/monitoring/ndjson-metric-exporter.test.ts
```

Expected: Pass (the partitioning is transparent to the OTel exporter interface).

### Step 4: Commit

```bash
git add apps/mesh/src/monitoring/ndjson-log-exporter.ts apps/mesh/src/monitoring/ndjson-metric-exporter.ts
git commit -m "feat(monitoring): partition log and metric exports by organization_id"
```

---

## Task 3: Update retention cleanup for org-sharded directories

The current `cleanupOldMonitoringFiles` walks `basePath/YYYY/MM/DD/HH/`. With org sharding, it needs to walk `basePath/<org_id>/YYYY/MM/DD/HH/`.

**Files:**
- Modify: `apps/mesh/src/monitoring/ndjson-retention.ts`
- Modify: `apps/mesh/src/monitoring/ndjson-retention.test.ts`

### Step 1: Write failing test for org-sharded retention

Add to `ndjson-retention.test.ts`:

```typescript
it("should clean up old files inside org subdirectories", async () => {
  const old = new Date();
  old.setUTCDate(old.getUTCDate() - 31);

  // Create org-sharded old data
  const oldPath = join(
    tmpDir,
    "org_abc",
    String(old.getUTCFullYear()),
    String(old.getUTCMonth() + 1).padStart(2, "0"),
    String(old.getUTCDate()).padStart(2, "0"),
    "00",
  );
  await mkdir(oldPath, { recursive: true });
  await writeFile(join(oldPath, "test.ndjson"), "old-data");

  // Create org-sharded new data
  const now = new Date();
  const newPath = join(
    tmpDir,
    "org_abc",
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
  );
  await mkdir(newPath, { recursive: true });
  await writeFile(join(newPath, "test.ndjson"), "new-data");

  const deleted = await cleanupOldMonitoringFiles(tmpDir);
  expect(deleted).toBeGreaterThanOrEqual(1);

  const allFiles = await readdir(tmpDir, { recursive: true });
  const ndjsonFiles = allFiles.filter((f) => f.endsWith(".ndjson"));
  expect(ndjsonFiles.length).toBe(1);
});
```

### Step 2: Run test, verify it fails

```bash
bun test apps/mesh/src/monitoring/ndjson-retention.test.ts
```

Expected: Fails because `org_abc` is not a 4-digit year, so the current code skips it entirely.

### Step 3: Implement org-aware retention

Update `cleanupOldMonitoringFiles` in `ndjson-retention.ts` to handle both layouts:

```typescript
export async function cleanupOldMonitoringFiles(
  basePath: string,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  cutoff.setUTCHours(0, 0, 0, 0);

  let deleted = 0;

  try {
    const topLevel = await safeReaddir(basePath);
    for (const entry of topLevel) {
      if (/^\d{4}$/.test(entry)) {
        // Legacy non-sharded: basePath/YYYY/MM/DD/HH/
        deleted += await cleanupYearDir(basePath, entry, cutoff);
      } else if (!entry.startsWith(".")) {
        // Org-sharded: basePath/<org_id>/YYYY/MM/DD/HH/
        const orgPath = join(basePath, entry);
        const years = await safeReaddir(orgPath);
        for (const year of years) {
          if (!/^\d{4}$/.test(year)) continue;
          deleted += await cleanupYearDir(orgPath, year, cutoff);
        }
        // Clean up empty org directory
        const remaining = await safeReaddir(orgPath);
        if (remaining.length === 0) {
          await rm(orgPath, { recursive: true, force: true });
        }
      }
    }
  } catch (err) {
    console.warn("monitoring retention cleanup failed:", err);
  }

  return deleted;
}
```

Extract the year/month/day walking into a helper `cleanupYearDir(parentPath, year, cutoff)` that returns the count of deleted day directories.

### Step 4: Run all retention tests

```bash
bun test apps/mesh/src/monitoring/ndjson-retention.test.ts
```

Expected: All pass (both old layout tests and new org-sharded test).

### Step 5: Commit

```bash
git add apps/mesh/src/monitoring/ndjson-retention.ts apps/mesh/src/monitoring/ndjson-retention.test.ts
git commit -m "feat(monitoring): support org-sharded directories in retention cleanup"
```

---

## Task 4: Replace chdb with `@duckdb/node-api`

**Files:**
- Modify: `apps/mesh/package.json` — replace `chdb` optional dep with `@duckdb/node-api`
- Modify: `package.json` (root) — update `trustedDependencies`
- Modify: `apps/mesh/src/monitoring/query-engine.ts`
- Modify: `apps/mesh/src/monitoring/query-engine.test.ts`

### Step 1: Install `@duckdb/node-api`

```bash
cd apps/mesh && bun remove chdb && bun add @duckdb/node-api
```

Also update root `package.json` `trustedDependencies` — remove `"chdb"`, add `"@duckdb/node-api"` and `"@duckdb/node-bindings"`.

### Step 2: Write failing test for DuckDBEngine

Replace the `ChdbEngine` tests in `query-engine.test.ts` with `DuckDBEngine` tests. The test structure is the same — write NDJSON to disk, query with the engine:

```typescript
import { DuckDBEngine, ClickHouseClientEngine, createMonitoringEngine } from "./query-engine";

let duckdbAvailable = false;
try {
  await import("@duckdb/node-api");
  duckdbAvailable = true;
} catch {}

describe.skipIf(!duckdbAvailable)("DuckDBEngine", () => {
  let tmpDir: string;
  let engine: DuckDBEngine;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "duckdb-engine-test-"));
    const subdir = join(tmpDir, "2026", "03", "05", "12");
    await mkdir(subdir, { recursive: true });

    await writeTestNDJSON(subdir, [
      makeTestMonitoringRow({
        id: "log_1",
        tool_name: "TOOL_A",
        duration_ms: 100,
        is_error: 0,
        output: '{"tokens": 42}',
      }),
      makeTestMonitoringRow({
        id: "log_2",
        tool_name: "TOOL_B",
        duration_ms: 200,
        is_error: 1,
        error_message: "timeout",
        output: '{"tokens": 10}',
      }),
    ]);

    engine = new DuckDBEngine();
  });

  afterAll(async () => {
    await engine.destroy();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should execute a query and return parsed rows", async () => {
    const source = `read_ndjson('${tmpDir}/**/*.ndjson', auto_detect=true)`;
    const rows = await engine.query(
      `SELECT * FROM ${source} WHERE organization_id = 'org_test'`,
    );
    expect(rows.length).toBe(2);
    expect(rows[0]!.organization_id).toBe("org_test");
  });

  it("should handle empty results", async () => {
    const source = `read_ndjson('${tmpDir}/**/*.ndjson', auto_detect=true)`;
    const rows = await engine.query(
      `SELECT * FROM ${source} WHERE organization_id = 'nonexistent'`,
    );
    expect(rows.length).toBe(0);
  });

  it("should handle concurrent queries", async () => {
    const source = `read_ndjson('${tmpDir}/**/*.ndjson', auto_detect=true)`;
    const [r1, r2, r3] = await Promise.all([
      engine.query(`SELECT count(*) AS cnt FROM ${source}`),
      engine.query(`SELECT tool_name FROM ${source} WHERE is_error = 1`),
      engine.query(`SELECT avg(duration_ms) AS avg_ms FROM ${source}`),
    ]);

    expect(Number(r1[0]!.cnt)).toBe(2);
    expect(r2[0]!.tool_name).toBe("TOOL_B");
    expect(Number(r3[0]!.avg_ms)).toBe(150);
  });
});
```

### Step 3: Run test, verify it fails

```bash
bun test apps/mesh/src/monitoring/query-engine.test.ts
```

Expected: Fails because `DuckDBEngine` doesn't exist yet.

### Step 4: Implement `DuckDBEngine`

Replace the `ChdbEngine` class in `query-engine.ts`:

```typescript
/**
 * DuckDB engine for local monitoring queries.
 * Uses @duckdb/node-api (native N-API binding) to query NDJSON files from disk.
 */
export class DuckDBEngine implements QueryEngine {
  private connectionPromise: Promise<unknown>;

  constructor() {
    this.connectionPromise = import("@duckdb/node-api").then(
      async ({ DuckDBInstance }) => {
        const instance = await DuckDBInstance.create();
        return instance.connect();
      },
    );
  }

  async query(sql: string): Promise<Record<string, unknown>[]> {
    const connection = (await this.connectionPromise) as import("@duckdb/node-api").DuckDBConnection;
    const reader = await connection.runAndReadAll(sql);
    const columns = reader.columnNames();
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < reader.currentRowCount; i++) {
      const row: Record<string, unknown> = {};
      for (let c = 0; c < columns.length; c++) {
        row[columns[c]!] = reader.getColumns()[c]!.getItem(i);
      }
      rows.push(row);
    }
    return rows;
  }

  async destroy(): Promise<void> {
    // Connection will be GC'd
  }
}
```

**Important:** The exact API shape may vary slightly. After installing the package, check the actual types from `@duckdb/node-api`. The key methods are:
- `DuckDBInstance.create()` — create an in-memory instance
- `instance.connect()` — get a connection
- `connection.runAndReadAll(sql)` — execute and read results

The result reader API may use `getColumns()` / `columnNames()` / `currentRowCount`. Verify against the actual types and adjust accordingly. DuckDB docs: the Neo client uses `DuckDBResult` with column-oriented access.

### Step 5: Update `createMonitoringEngine`

The source expression changes from chdb's `file()` syntax to DuckDB's `read_ndjson()`:

```typescript
export function createMonitoringEngine(config: MonitoringEngineConfig): {
  engine: QueryEngine;
  source: string;
} {
  if (config.clickhouseUrl) {
    return {
      engine: new ClickHouseClientEngine(config.clickhouseUrl),
      source: config.tableName ?? DEFAULT_TABLE_NAME,
    };
  }

  const basePath = config.basePath ?? DEFAULT_LOGS_DIR;
  const resolvedPath = resolve(basePath);
  if (/[';]/.test(resolvedPath)) {
    throw new Error(`Invalid monitoring data path: ${resolvedPath}`);
  }

  try {
    return {
      engine: new DuckDBEngine(),
      source: `read_ndjson('${resolvedPath}/**/*.ndjson', union_by_name=true, auto_detect=true)`,
    };
  } catch (err) {
    console.warn(
      "\n  WARNING: @duckdb/node-api failed to load — monitoring will return empty results.\n" +
        `   Error: ${err instanceof Error ? err.message : err}\n` +
        "   Fix: run `bun add @duckdb/node-api` in apps/mesh/ to install.\n",
    );
    return {
      engine: new NoopEngine(),
      source: `read_ndjson('${resolvedPath}/**/*.ndjson', union_by_name=true, auto_detect=true)`,
    };
  }
}
```

Update the `NoopEngine` warning message to reference DuckDB instead of chdb.

### Step 6: Update `createMonitoringEngine` tests

Update the assertions:

```typescript
describe("createMonitoringEngine", () => {
  it.skipIf(!duckdbAvailable)(
    "should create DuckDBEngine when no CLICKHOUSE_URL",
    () => {
      const { engine, source } = createMonitoringEngine({
        basePath: "./data/monitoring",
      });
      expect(engine).toBeInstanceOf(DuckDBEngine);
      expect(source).toContain("read_ndjson(");
      expect(source).toContain(".ndjson");
    },
  );

  it("should use DEFAULT_LOGS_DIR when no basePath", () => {
    const { source } = createMonitoringEngine({});
    expect(source).toContain("deco/logs");
  });

  // ClickHouse tests unchanged
});
```

### Step 7: Run tests, verify they pass

```bash
bun test apps/mesh/src/monitoring/query-engine.test.ts
```

### Step 8: Commit

```bash
git add apps/mesh/src/monitoring/query-engine.ts apps/mesh/src/monitoring/query-engine.test.ts apps/mesh/package.json ../../package.json ../../bun.lock
git commit -m "feat(monitoring): replace chdb with @duckdb/node-api for local queries"
```

---

## Task 5: Org-aware source expressions in the storage layer

Now that the exporter writes to `basePath/<org_id>/...`, the query engine should build the source glob with the org_id baked in: `read_ndjson('basePath/<org_id>/**/*.ndjson')`.

**Files:**
- Modify: `apps/mesh/src/monitoring/query-engine.ts`
- Modify: `apps/mesh/src/storage/monitoring-clickhouse.ts`
- Modify: `apps/mesh/src/core/context-factory.ts`
- Modify: `apps/mesh/src/storage/monitoring-clickhouse.test.ts`

### Step 1: Add `organizationId` parameter to `createMonitoringEngine`

In `query-engine.ts`, add `organizationId` to the config:

```typescript
export interface MonitoringEngineConfig {
  clickhouseUrl?: string;
  basePath?: string;
  tableName?: string;
  organizationId?: string;  // NEW
}
```

When `organizationId` is provided and we're using local DuckDB, insert it in the glob:

```typescript
const orgSegment = config.organizationId ? `${config.organizationId}/` : "";
return {
  engine: new DuckDBEngine(),
  source: `read_ndjson('${resolvedPath}/${orgSegment}**/*.ndjson', union_by_name=true, auto_detect=true)`,
};
```

For ClickHouse (cloud), this param is ignored — the WHERE clause handles filtering.

### Step 2: Make `ClickHouseMonitoringStorage` create org-scoped sources lazily

The storage currently receives engine+source at construction time. Since the org_id varies per request, we need a factory approach for local mode.

**Option A (recommended):** The storage class receives a `sourceFactory: (orgId: string) => string` instead of a static `source` string. For ClickHouse, the factory ignores orgId and returns the table name. For DuckDB, it builds the glob.

Change the constructor signature:

```typescript
export class ClickHouseMonitoringStorage implements MonitoringStorage {
  constructor(
    private engine: QueryEngine,
    private sourceFactory: (organizationId: string) => string,
    private metricEngine: QueryEngine,
    private metricSourceFactory: (organizationId: string) => string,
  ) {}
}
```

Then in every method that currently uses `this.source`, call `this.sourceFactory(filters.organizationId)`:

```typescript
// Before:
const sql = `SELECT ... FROM ${this.source} WHERE ${where.join(" AND ")} ...`;

// After:
const source = this.sourceFactory(filters.organizationId);
const sql = `SELECT ... FROM ${source} WHERE ${where.join(" AND ")} ...`;
```

Apply the same change to metric queries using `this.metricSourceFactory(params.organizationId)`.

### Step 3: Update `context-factory.ts`

In `context-factory.ts`, change from static source strings to factory functions:

```typescript
const basePath = resolve(DEFAULT_LOGS_DIR);
const metricsBasePath = resolve(DEFAULT_METRICS_DIR);

const monitoringEngine = env.CLICKHOUSE_URL
  ? new ClickHouseClientEngine(env.CLICKHOUSE_URL)
  : createLocalEngine(); // helper that creates DuckDBEngine or NoopEngine

const logSourceFactory = env.CLICKHOUSE_URL
  ? (_orgId: string) => "monitoring_logs"
  : (orgId: string) => `read_ndjson('${basePath}/${orgId}/**/*.ndjson', union_by_name=true, auto_detect=true)`;

const metricSourceFactory = env.CLICKHOUSE_URL
  ? (_orgId: string) => "monitoring_metrics"
  : (orgId: string) => `read_ndjson('${metricsBasePath}/${orgId}/**/*.ndjson', union_by_name=true, auto_detect=true)`;

const monitoring = new ClickHouseMonitoringStorage(
  monitoringEngine,
  logSourceFactory,
  metricEngine,
  metricSourceFactory,
);
```

### Step 4: Update tests in `monitoring-clickhouse.test.ts`

Update the test setup to use the new constructor signature:

```typescript
const source = (orgId: string) => `read_ndjson('${dataDir}/*.ndjson', union_by_name=true, auto_detect=true)`;
const metricSource = (orgId: string) => `read_ndjson('${metricsDir}/*.ndjson', union_by_name=true, auto_detect=true)`;
storage = new ClickHouseMonitoringStorage(engine, source, engine, metricSource);
```

Change the `skipIf` condition from `chdbAvailable` to `duckdbAvailable`:

```typescript
let duckdbAvailable = false;
try {
  await import("@duckdb/node-api");
  duckdbAvailable = true;
} catch {}

describe.skipIf(!duckdbAvailable)("ClickHouseMonitoringStorage", () => {
  // ...
  engine = new DuckDBEngine();
  // ...
});
```

### Step 5: Run all monitoring tests

```bash
bun test apps/mesh/src/monitoring/ apps/mesh/src/storage/monitoring-clickhouse.test.ts
```

### Step 6: Commit

```bash
git add apps/mesh/src/monitoring/query-engine.ts apps/mesh/src/storage/monitoring-clickhouse.ts apps/mesh/src/core/context-factory.ts apps/mesh/src/storage/monitoring-clickhouse.test.ts
git commit -m "feat(monitoring): org-scoped source expressions for filesystem partition pruning"
```

---

## Task 6: Update test-utils and integration test

**Files:**
- Modify: `apps/mesh/src/monitoring/test-utils.ts`
- Modify: `apps/mesh/src/monitoring/pipeline.integration.test.ts`

### Step 1: Add org-aware test helpers

In `test-utils.ts`, add a helper for creating org-sharded test directories:

```typescript
export async function writeTestNDJSONSharded(
  basePath: string,
  orgId: string,
  rows: MonitoringRow[],
): Promise<void> {
  const dir = join(basePath, orgId, "2026", "03", "05", "12");
  await mkdir(dir, { recursive: true });
  await writeTestNDJSON(dir, rows);
}
```

Update the `duckdbAvailable` check helper:

```typescript
export async function isDuckDBAvailable(): Promise<boolean> {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}
```

### Step 2: Update integration test

In `pipeline.integration.test.ts`, replace any `chdb` references with DuckDB references. The integration test should verify the full pipeline: emit -> NDJSON export -> DuckDB query, and confirm org-sharded paths.

### Step 3: Run all tests

```bash
bun test apps/mesh/src/monitoring/ apps/mesh/src/storage/monitoring-clickhouse.test.ts
```

### Step 4: Commit

```bash
git add apps/mesh/src/monitoring/test-utils.ts apps/mesh/src/monitoring/pipeline.integration.test.ts
git commit -m "test(monitoring): update test utils and integration tests for duckdb + org sharding"
```

---

## Task 7: Update bundle script (if needed)

**Files:**
- Modify: `apps/mesh/scripts/bundle-server-script.ts`

### Step 1: Verify `@duckdb/node-api` bundling

Since `@duckdb/node-api` is a native N-API module (not WASM), it should be handled by `@vercel/nft` trace automatically — the native `.node` binary will be included in the dependency trace.

Run the server build and check:

```bash
cd apps/mesh && bun run build:server
```

Verify the output `dist/server/node_modules/@duckdb/` contains the needed files.

### Step 2: If `@duckdb/node-api` is not traced correctly

Add it to the `ALWAYS_INCLUDE` array in `bundle-server-script.ts`:

```typescript
const ALWAYS_INCLUDE = [
  "@jitl/quickjs-wasmfile-release-sync",
  "@electric-sql/pglite",
  "@duckdb/node-api",      // native N-API binding
  "@duckdb/node-bindings",  // contains the .node binary
];
```

### Step 3: Remove chdb from any bundle references

Since chdb was an optional dependency and not in `ALWAYS_INCLUDE`, no changes needed for removal. But verify it's no longer referenced anywhere.

### Step 4: Run build and verify

```bash
bun run build:server && ls -la dist/server/node_modules/@duckdb/
```

### Step 5: Commit (only if changes were needed)

```bash
git add apps/mesh/scripts/bundle-server-script.ts
git commit -m "chore(build): ensure @duckdb/node-api is included in server bundle"
```

---

## Task 8: Full test suite + format + lint

### Step 1: Run formatter

```bash
bun run fmt
```

### Step 2: Run linter

```bash
bun run lint
```

### Step 3: Run type checker

```bash
bun run check
```

### Step 4: Run full test suite

```bash
bun test
```

### Step 5: Fix any issues, commit

```bash
git add -A
git commit -m "chore: fix lint/format issues from monitoring refactor"
```

---

## SQL Dialect Differences: chdb (ClickHouse) vs DuckDB

The `ClickHouseMonitoringStorage` class builds SQL using ClickHouse syntax. Some functions need adjustment for DuckDB:

| ClickHouse | DuckDB | Used in |
|------------|--------|---------|
| `file('path', 'JSONEachRow')` | `read_ndjson('path')` | source expression |
| `parseDateTime64BestEffort(toString(timestamp))` | `timestamp::TIMESTAMP` or `strptime(timestamp, '%Y-%m-%dT%H:%M:%S')` | timestamp filters |
| `toStartOfInterval(ts, INTERVAL N UNIT)` | `time_bucket(INTERVAL 'N UNIT', ts)` | timeseries grouping |
| `JSONExtractString(col, 'key')` | `col::JSON->>'key'` or `json_extract_string(col, '$.key')` | property filters, aggregation |
| `JSONExtractFloat(col, 'key')` | `CAST(col::JSON->>'key' AS DOUBLE)` | numeric aggregation |
| `sumIf(val, cond)` | `SUM(CASE WHEN cond THEN val ELSE 0 END)` or `SUM(val) FILTER (WHERE cond)` | metric queries |
| `groupArrayIf(col, cond)` | `LIST(col) FILTER (WHERE cond)` | histogram aggregation |
| `argMax(val, ts)` | `ARG_MAX(val, ts)` | same (DuckDB has it!) |
| `splitByChar(',', str)` | `string_split(str, ',')` | property in-values |
| `has(arr, val)` | `list_contains(arr, val)` | property in-values |

**Strategy:** Rather than maintaining two SQL dialects in one class, the cleanest approach is:

1. **Cloud (ClickHouse):** `ClickHouseMonitoringStorage` continues unchanged — it only runs against ClickHouse.
2. **Local (DuckDB):** Create a thin adapter `DuckDBMonitoringStorage` that extends or wraps `ClickHouseMonitoringStorage` but overrides the SQL-building helpers for DuckDB syntax.

**OR** (simpler, recommended for now): Make the storage class dialect-aware with a `dialect: "clickhouse" | "duckdb"` flag, and branch in the few helper functions that differ (`tsGte`, `tsLte`, `intervalToSQL`, `buildPropertyFilterClauses`, etc.). This avoids duplicating the entire class.

Add a `dialect` param to the constructor:

```typescript
type SqlDialect = "clickhouse" | "duckdb";

export class ClickHouseMonitoringStorage implements MonitoringStorage {
  constructor(
    private engine: QueryEngine,
    private sourceFactory: (organizationId: string) => string,
    private metricEngine: QueryEngine,
    private metricSourceFactory: (organizationId: string) => string,
    private dialect: SqlDialect = "clickhouse",
  ) {}
}
```

Then update helper functions:

```typescript
function tsGte(date: Date, dialect: SqlDialect): string {
  if (dialect === "duckdb") {
    return `CAST(timestamp AS TIMESTAMP) >= TIMESTAMP '${date.toISOString()}'`;
  }
  return `parseDateTime64BestEffort(toString(timestamp)) >= parseDateTime64BestEffort('${date.toISOString()}')`;
}
```

This task is woven into Task 5 — when updating the storage class, add the dialect parameter at the same time.

---

## Migration Path for Existing Data

Existing NDJSON files on disk are at `basePath/YYYY/MM/DD/HH/`. After this change, new files go to `basePath/<org_id>/YYYY/MM/DD/HH/`.

**No migration needed.** The retention system (Task 3) handles both layouts. Old data will be cleaned up within 30 days. For queries, both old and new data will be accessible if the source glob falls back to `basePath/**/*.ndjson` when no org_id is available. In practice, all monitoring queries require `organizationId`, so old unsharded data will be invisible to org-scoped queries.

**Option:** A one-time migration script could reshuffle existing files, but given the 30-day retention, it's not worth the complexity. Old data simply ages out.
