import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  DuckDBEngine,
  ClickHouseClientEngine,
  createMonitoringEngine,
} from "./query-engine";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestMonitoringRow, writeTestNDJSON } from "./test-utils";

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

describe("createMonitoringEngine", () => {
  it.skipIf(!duckdbAvailable)(
    "should create DuckDBEngine when no CLICKHOUSE_URL",
    async () => {
      const { engine, source } = await createMonitoringEngine({
        basePath: "./data/monitoring",
      });
      expect(engine).toBeInstanceOf(DuckDBEngine);
      expect(source).toContain("read_ndjson(");
      expect(source).toContain(".ndjson");
    },
  );

  it.skipIf(!duckdbAvailable)(
    "should use DEFAULT_LOGS_DIR when no basePath",
    async () => {
      const { engine, source } = await createMonitoringEngine({});
      try {
        expect(source).toContain("deco/logs");
      } finally {
        await engine.destroy?.();
      }
    },
  );

  it("should create ClickHouseClientEngine when clickhouseUrl is set", async () => {
    const { engine, source } = await createMonitoringEngine({
      clickhouseUrl: "http://localhost:8123",
    });
    expect(engine).toBeInstanceOf(ClickHouseClientEngine);
    expect(source).toBe("monitoring_logs");
  });

  it("should use custom tableName when clickhouseUrl is set", async () => {
    const { engine, source } = await createMonitoringEngine({
      clickhouseUrl: "http://localhost:8123",
      tableName: "custom_table",
    });
    expect(engine).toBeInstanceOf(ClickHouseClientEngine);
    expect(source).toBe("custom_table");
  });
});
