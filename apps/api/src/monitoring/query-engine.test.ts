import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  DuckDBEngine,
  ClickHouseClientEngine,
  createMonitoringEngine,
  buildOtlpFlatSource,
  buildOtlpFlatSourceFromGlob,
  normalizeS3Endpoint,
} from "./query-engine";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeTestMonitoringRow,
  writeTestNDJSON,
  makeTestOtlpLogRecord,
  writeTestOtlpJson,
} from "./test-utils";

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

  it("enables disk spill and applies memory tuning so large queries don't hard-OOM", async () => {
    const tuned = new DuckDBEngine(undefined, {
      memoryLimit: "512MiB",
      threads: 2,
    });
    try {
      const [order, mem, threads, temp] = await Promise.all([
        tuned.query("SELECT current_setting('preserve_insertion_order') AS v"),
        tuned.query("SELECT current_setting('memory_limit') AS v"),
        tuned.query("SELECT current_setting('threads') AS v"),
        tuned.query("SELECT current_setting('temp_directory') AS v"),
      ]);
      expect(String(order[0]!.v)).toBe("false");
      // DuckDB normalizes the byte unit (512MiB → "512.0 MiB").
      expect(String(mem[0]!.v)).toContain("512");
      expect(Number(threads[0]!.v)).toBe(2);
      // A non-empty temp_directory is what lets in-memory DuckDB spill.
      expect(String(temp[0]!.v).length).toBeGreaterThan(0);
    } finally {
      await tuned.destroy();
    }
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
    expect(source).toBe("studio_monitoring_logs");
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

describe("normalizeS3Endpoint", () => {
  it("strips https scheme and keeps SSL on", () => {
    expect(normalizeS3Endpoint("https://storage.googleapis.com")).toEqual({
      host: "storage.googleapis.com",
      useSsl: true,
    });
  });

  it("strips http scheme and turns SSL off", () => {
    expect(normalizeS3Endpoint("http://localhost:9000")).toEqual({
      host: "localhost:9000",
      useSsl: false,
    });
  });

  it("defaults a scheme-less host to SSL", () => {
    expect(normalizeS3Endpoint("storage.googleapis.com")).toEqual({
      host: "storage.googleapis.com",
      useSsl: true,
    });
  });

  it("trims trailing slashes", () => {
    expect(normalizeS3Endpoint("https://storage.googleapis.com/")).toEqual({
      host: "storage.googleapis.com",
      useSsl: true,
    });
  });
});

describe("buildOtlpFlatSource", () => {
  // glob is **/* (not *.json) — the google_cloud_storage exporter writes
  // extensionless objects (logs_<uuid>); read_json(format='auto') detects JSON.
  it("builds an s3:// glob with prefix", () => {
    const src = buildOtlpFlatSource({ bucket: "my-bucket", prefix: "logs" });
    expect(src).toContain("s3://my-bucket/logs/**/*");
  });

  it("omits an empty prefix", () => {
    const src = buildOtlpFlatSource({ bucket: "my-bucket", prefix: "" });
    expect(src).toContain("s3://my-bucket/**/*");
  });

  it("trims slashes from the prefix", () => {
    const src = buildOtlpFlatSource({ bucket: "b", prefix: "/logs/" });
    expect(src).toContain("s3://b/logs/**/*");
  });

  it("rejects injection in bucket/prefix", () => {
    expect(() =>
      buildOtlpFlatSource({ bucket: "b';--", prefix: "" }),
    ).toThrow();
    expect(() => buildOtlpFlatSource({ bucket: "b", prefix: "p'" })).toThrow();
  });

  it("reads the whole prefix (no Hive pruning) without a date range", () => {
    const src = buildOtlpFlatSource({ bucket: "b", prefix: "logs" });
    expect(src).toContain("s3://b/logs/**/*");
    expect(src).not.toContain("hive_partitioning");
    expect(src).not.toContain("make_date");
  });

  it("turns on Hive pruning with a ±1-day date predicate given a range", () => {
    const src = buildOtlpFlatSource({
      bucket: "b",
      prefix: "logs",
      range: {
        startDate: new Date("2026-03-15T00:00:00.000Z"),
        endDate: new Date("2026-03-15T23:59:59.000Z"),
      },
    });
    // Glob rooted at year=*/ so legacy non-Hive objects are excluded.
    expect(src).toContain("s3://b/logs/year=*/**/*");
    expect(src).toContain("hive_partitioning=true");
    // Padded -1/+1 day so partition-day pruning never drops a file that could
    // hold an in-range row, regardless of the collector's partition timezone.
    expect(src).toContain(
      "make_date(CAST(year AS INT), CAST(month AS INT), CAST(day AS INT)) >= DATE '2026-03-14'",
    );
    expect(src).toContain("<= DATE '2026-03-16'");
  });
});

describe.skipIf(!duckdbAvailable)("OTLP flat source over local fixture", () => {
  let tmpDir: string;
  let engine: DuckDBEngine;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "otlp-flat-test-"));
    await writeTestOtlpJson(tmpDir, [
      makeTestOtlpLogRecord({
        id: "span_a",
        tool_name: "TOOL_A",
        is_error: 0,
        duration_ms: 100,
        input: '{"q":"hi"}',
        output: '{"tokens":42}',
        timestamp: "2026-03-05T12:00:00.000Z",
      }),
      makeTestOtlpLogRecord({
        id: "span_b",
        tool_name: "TOOL_B",
        is_error: 1,
        error_message: "boom",
        duration_ms: 250.5,
        timestamp: "2026-03-05T12:01:00.000Z",
      }),
      // Non-monitoring record — must be filtered out.
      makeTestOtlpLogRecord({ id: "span_c", type: "infra_noise" }),
    ]);
    engine = new DuckDBEngine();
  });

  afterAll(async () => {
    await engine.destroy();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("flattens OTLP-JSON to the flat columns and filters non-monitoring rows", async () => {
    const source = buildOtlpFlatSourceFromGlob(`${tmpDir}/**/*.json`);
    const rows = await engine.query(
      `SELECT * FROM ${source} WHERE organization_id = 'org_test' ORDER BY id`,
    );
    expect(rows.length).toBe(2); // infra_noise excluded

    const a = rows[0]!;
    expect(a.id).toBe("span_a"); // id === spanId
    expect(a.tool_name).toBe("TOOL_A");
    expect(a.is_error).toBe(0);
    expect(Number(a.duration_ms)).toBe(100);
    expect(a.input).toBe('{"q":"hi"}');
    expect(a.output).toBe('{"tokens":42}');
    // timestamp round-trips from timeUnixNano
    expect(new Date(String(a.timestamp)).toISOString()).toBe(
      "2026-03-05T12:00:00.000Z",
    );

    const b = rows[1]!;
    expect(b.is_error).toBe(1);
    expect(b.error_message).toBe("boom");
    expect(Number(b.duration_ms)).toBe(250.5);
  });
});

describe.skipIf(!duckdbAvailable)(
  "Hive-partition pruning over local fixture",
  () => {
    let tmpDir: string;
    let engine: DuckDBEngine;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "otlp-hive-test-"));
      // Two day partitions far apart so a one-day range prunes the other file.
      const fixtures: Array<[string, string, string]> = [
        ["01", "2026-03-01T12:00:00.000Z", "span_old"],
        ["15", "2026-03-15T12:00:00.000Z", "span_new"],
      ];
      for (const [day, ts, id] of fixtures) {
        const dir = join(
          tmpDir,
          "year=2026",
          "month=03",
          `day=${day}`,
          "hour=12",
        );
        await mkdir(dir, { recursive: true });
        await writeTestOtlpJson(dir, [
          makeTestOtlpLogRecord({ id, tool_name: "TOOL", timestamp: ts }),
        ]);
      }
      engine = new DuckDBEngine();
    });

    afterAll(async () => {
      await engine.destroy();
      await rm(tmpDir, { recursive: true, force: true });
    });

    const glob = () => `${tmpDir}/**/*`;

    it("prunes the data scan to the in-range day partition", async () => {
      const source = buildOtlpFlatSourceFromGlob(glob(), {
        range: {
          startDate: new Date("2026-03-15T00:00:00.000Z"),
          endDate: new Date("2026-03-15T23:59:59.000Z"),
        },
      });
      const rows = await engine.query(
        `SELECT id FROM ${source} WHERE organization_id = 'org_test'`,
      );
      expect(rows.map((r) => r.id)).toEqual(["span_new"]);

      // Prove DuckDB pruned the file (didn't just row-filter): the day=01 object
      // is never read by the data scan, which is where the OOM-causing flatten
      // happens.
      const explain = await engine.query(
        `EXPLAIN ANALYZE SELECT id FROM ${source} WHERE organization_id = 'org_test'`,
      );
      const text = explain.map((r) => Object.values(r).join(" ")).join("\n");
      expect(text).toMatch(/Total Files Read:\s*1\b/);
    });

    it("reads every partition when no range is given", async () => {
      const source = buildOtlpFlatSourceFromGlob(glob());
      const rows = await engine.query(
        `SELECT id FROM ${source} WHERE organization_id = 'org_test' ORDER BY id`,
      );
      expect(rows.map((r) => r.id)).toEqual(["span_new", "span_old"]);
    });
  },
);

describe.skipIf(!duckdbAvailable)(
  "Hive pruning skips legacy non-partitioned garbage",
  () => {
    let tmpDir: string;
    let engine: DuckDBEngine;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "otlp-garbage-test-"));
      // Good OTLP under the documented year=/month=/day= layout (in range).
      const good = join(tmpDir, "year=2026", "month=03", "day=15", "hour=12");
      await mkdir(good, { recursive: true });
      await writeTestOtlpJson(good, [
        makeTestOtlpLogRecord({
          id: "span_good",
          timestamp: "2026-03-15T12:00:00.000Z",
        }),
      ]);
      // Legacy leftovers NOT under the Hive layout: a flat object at the prefix
      // root, and an older key=value scheme. With a root **/* glob these trip
      // DuckDB's "Hive partition mismatch"; the year=*/ glob root excludes them.
      await writeFile(
        join(tmpDir, "legacy_dump.json"),
        JSON.stringify({ old: "format" }),
      );
      const oldScheme = join(tmpDir, "region=us", "svc=studio");
      await mkdir(oldScheme, { recursive: true });
      await writeFile(join(oldScheme, "old"), JSON.stringify({ legacy: 1 }));
      engine = new DuckDBEngine();
    });

    afterAll(async () => {
      await engine.destroy();
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("excludes flat / old-layout objects without erroring", async () => {
      // Mirrors the glob buildOtlpFlatSource roots at year=*/ when pruning.
      const source = buildOtlpFlatSourceFromGlob(`${tmpDir}/year=*/**/*`, {
        range: {
          startDate: new Date("2026-03-15T00:00:00.000Z"),
          endDate: new Date("2026-03-15T23:59:59.000Z"),
        },
      });
      const rows = await engine.query(
        `SELECT id FROM ${source} WHERE organization_id = 'org_test'`,
      );
      expect(rows.map((r) => r.id)).toEqual(["span_good"]);
    });
  },
);
