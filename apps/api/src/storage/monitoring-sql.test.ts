import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DuckDBEngine,
  buildOtlpFlatSourceFromGlob,
} from "../monitoring/query-engine";
import type {
  MonitoringDateRange,
  QueryEngine,
} from "../monitoring/query-engine";
import type { MetricRow } from "../monitoring/schema";
import {
  makeTestMonitoringRow,
  writeTestNDJSON,
  makeTestOtlpLogRecord,
  writeTestOtlpJson,
} from "../monitoring/test-utils";
import { SqlMonitoringStorage } from "./monitoring-sql";

let duckdbAvailable = false;
try {
  require("@duckdb/node-api");
  duckdbAvailable = true;
} catch {}

describe.skipIf(!duckdbAvailable)("SqlMonitoringStorage", () => {
  let tmpDir: string;
  let engine: DuckDBEngine;
  let storage: SqlMonitoringStorage;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "monitoring-ch-test-"));
    const dataDir = join(tmpDir, "2026", "03", "06", "12");
    const metricsDir = join(tmpDir, "metrics", "2026", "03", "06", "12");
    await mkdir(dataDir, { recursive: true });
    await mkdir(metricsDir, { recursive: true });
    engine = new DuckDBEngine();

    const sourceFactory = (_orgId: string) =>
      `read_ndjson('${dataDir}/*.ndjson', auto_detect=true)`;
    const metricSourceFactory = (_orgId: string) =>
      `read_ndjson('${metricsDir}/*.ndjson', auto_detect=true)`;
    storage = new SqlMonitoringStorage(
      engine,
      sourceFactory,
      engine,
      metricSourceFactory,
      "duckdb",
    );

    const rows = [
      makeTestMonitoringRow({
        id: "log_1",
        tool_name: "TOOL_A",
        duration_ms: 100,
        is_error: 0,
        organization_id: "org_test",
        connection_id: "conn_1",
        connection_title: "Server A",
        timestamp: "2026-03-05T12:00:00.000Z",
        request_id: "req_1",
        user_id: "user_1",
      }),
      makeTestMonitoringRow({
        id: "log_2",
        tool_name: "TOOL_A",
        duration_ms: 200,
        is_error: 1,
        error_message: "timeout",
        organization_id: "org_test",
        connection_id: "conn_1",
        connection_title: "Server A",
        timestamp: "2026-03-05T12:01:00.000Z",
        request_id: "req_2",
        user_id: "user_1",
      }),
      makeTestMonitoringRow({
        id: "log_3",
        tool_name: "TOOL_B",
        duration_ms: 50,
        is_error: 0,
        organization_id: "org_test",
        connection_id: "conn_2",
        connection_title: "Server B",
        timestamp: "2026-03-05T12:02:00.000Z",
        request_id: "req_3",
        user_id: "user_2",
      }),
      makeTestMonitoringRow({
        id: "log_4",
        tool_name: "TOOL_A",
        duration_ms: 300,
        is_error: 0,
        organization_id: "org_test",
        connection_id: "conn_1",
        connection_title: "Server A",
        output: '{"tokens":200,"model":"gpt-4"}',
        properties: '{"env":"prod","team":"backend"}',
        virtual_mcp_id: "vmcp_1",
        timestamp: "2026-03-05T12:03:00.000Z",
        request_id: "req_4",
        user_id: "user_1",
      }),
      makeTestMonitoringRow({
        id: "log_5",
        tool_name: "TOOL_C",
        duration_ms: 75,
        is_error: 0,
        organization_id: "org_other",
        connection_id: "conn_3",
        connection_title: "Server C",
        timestamp: "2026-03-05T12:04:00.000Z",
        request_id: "req_5",
        user_id: "user_3",
      }),
    ];

    await writeTestNDJSON(dataDir, rows);

    const metricRows: MetricRow[] = [
      {
        v: 1,
        name: "tool.execution.count",
        type: "sum",
        unit: "1",
        timestamp: "2026-03-05T12:00:00.000Z",
        organization_id: "org_test",
        connection_id: "conn_1",
        tool_name: "TOOL_A",
        status: "success",
        error_type: "",
        value: 2,
        hist_count: 0,
        hist_sum: 0,
        hist_min: 0,
        hist_max: 0,
        hist_boundaries: "[]",
        hist_bucket_counts: "[]",
      },
      {
        v: 1,
        name: "tool.execution.count",
        type: "sum",
        unit: "1",
        timestamp: "2026-03-05T12:00:00.000Z",
        organization_id: "org_test",
        connection_id: "conn_1",
        tool_name: "TOOL_A",
        status: "error",
        error_type: "Error",
        value: 1,
        hist_count: 0,
        hist_sum: 0,
        hist_min: 0,
        hist_max: 0,
        hist_boundaries: "[]",
        hist_bucket_counts: "[]",
      },
      {
        v: 1,
        name: "tool.execution.duration",
        type: "histogram",
        unit: "ms",
        timestamp: "2026-03-05T12:00:00.000Z",
        organization_id: "org_test",
        connection_id: "conn_1",
        tool_name: "TOOL_A",
        status: "success",
        error_type: "",
        value: 2,
        hist_count: 2,
        hist_sum: 400,
        hist_min: 100,
        hist_max: 300,
        hist_boundaries: "[100,250,500]",
        hist_bucket_counts: "[1,0,1,0]",
      },
      {
        v: 1,
        name: "tool.execution.duration",
        type: "histogram",
        unit: "ms",
        timestamp: "2026-03-05T12:00:00.000Z",
        organization_id: "org_test",
        connection_id: "conn_1",
        tool_name: "TOOL_A",
        status: "error",
        error_type: "Error",
        value: 1,
        hist_count: 1,
        hist_sum: 200,
        hist_min: 200,
        hist_max: 200,
        hist_boundaries: "[100,250,500]",
        hist_bucket_counts: "[0,1,0,0]",
      },
      {
        v: 1,
        name: "tool.execution.count",
        type: "sum",
        unit: "1",
        timestamp: "2026-03-05T12:00:00.000Z",
        organization_id: "org_test",
        connection_id: "conn_2",
        tool_name: "TOOL_B",
        status: "success",
        error_type: "",
        value: 1,
        hist_count: 0,
        hist_sum: 0,
        hist_min: 0,
        hist_max: 0,
        hist_boundaries: "[]",
        hist_bucket_counts: "[]",
      },
      {
        v: 1,
        name: "tool.execution.duration",
        type: "histogram",
        unit: "ms",
        timestamp: "2026-03-05T12:00:00.000Z",
        organization_id: "org_test",
        connection_id: "conn_2",
        tool_name: "TOOL_B",
        status: "success",
        error_type: "",
        value: 1,
        hist_count: 1,
        hist_sum: 50,
        hist_min: 50,
        hist_max: 50,
        hist_boundaries: "[100,250,500]",
        hist_bucket_counts: "[1,0,0,0]",
      },
      {
        v: 1,
        name: "tool.execution.count",
        type: "sum",
        unit: "1",
        timestamp: "2026-03-05T12:00:00.000Z",
        organization_id: "org_other",
        connection_id: "conn_3",
        tool_name: "TOOL_C",
        status: "success",
        error_type: "",
        value: 1,
        hist_count: 0,
        hist_sum: 0,
        hist_min: 0,
        hist_max: 0,
        hist_boundaries: "[]",
        hist_bucket_counts: "[]",
      },
    ];

    const metricContent =
      metricRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(join(metricsDir, "metrics.ndjson"), metricContent, {
      mode: 0o600,
    });
  });

  afterAll(async () => {
    await engine.destroy();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ============================================================================
  // query()
  // ============================================================================

  describe("query", () => {
    test("returns all logs for an organization", async () => {
      const result = await storage.query({ organizationId: "org_test" });
      expect(result.total).toBe(4);
      expect(result.logs).toHaveLength(4);
      expect(result.logs[0]!.id).toBe("log_4");
    });

    test("filters by toolName", async () => {
      const result = await storage.query({
        organizationId: "org_test",
        toolName: "TOOL_A",
      });
      expect(result.total).toBe(3);
      expect(result.logs.every((l) => l.toolName === "TOOL_A")).toBe(true);
    });

    test("filters by isError", async () => {
      const result = await storage.query({
        organizationId: "org_test",
        isError: true,
      });
      expect(result.total).toBe(1);
      expect(result.logs[0]!.id).toBe("log_2");
      expect(result.logs[0]!.isError).toBe(true);
      expect(result.logs[0]!.errorMessage).toBe("timeout");
    });

    test("pagination works correctly", async () => {
      const page1 = await storage.query({
        organizationId: "org_test",
        limit: 2,
        offset: 0,
      });
      expect(page1.logs).toHaveLength(2);
      expect(page1.total).toBe(4);

      const page2 = await storage.query({
        organizationId: "org_test",
        limit: 2,
        offset: 2,
      });
      expect(page2.logs).toHaveLength(2);
      expect(page2.total).toBe(4);

      const page1Ids = page1.logs.map((l) => l.id);
      const page2Ids = page2.logs.map((l) => l.id);
      expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);
    });

    test("org isolation: does not return other org data", async () => {
      const result = await storage.query({ organizationId: "org_other" });
      expect(result.total).toBe(1);
      expect(result.logs[0]!.id).toBe("log_5");
    });

    test("returns empty results for nonexistent org", async () => {
      const result = await storage.query({
        organizationId: "org_nonexistent",
      });
      expect(result.total).toBe(0);
      expect(result.logs).toHaveLength(0);
    });

    test("SQL injection in organizationId is escaped", async () => {
      const result = await storage.query({
        organizationId: "org' OR '1'='1",
      });
      expect(result.total).toBe(0);
    });

    test("SQL injection in toolName is escaped", async () => {
      const result = await storage.query({
        organizationId: "org_test",
        toolName: "'; DROP TABLE monitoring_logs; --",
      });
      expect(result.total).toBe(0);
    });

    test("SQL injection in connectionId is escaped", async () => {
      const result = await storage.query({
        organizationId: "org_test",
        connectionId: "' OR '1'='1",
      });
      expect(result.total).toBe(0);
    });
  });

  // ============================================================================
  // getStats()
  // ============================================================================

  describe("getStats", () => {
    test("returns correct stats", async () => {
      const stats = await storage.getStats({ organizationId: "org_test" });
      expect(stats.totalCalls).toBe(4);
      expect(stats.errorRate).toBeCloseTo(0.25, 2);
      expect(stats.avgDurationMs).toBeCloseTo(162.5, 1);
    });
  });

  describe("queryMetricTimeseries", () => {
    test("returns overview metrics with per-connection breakdown", async () => {
      const stats = await storage.queryMetricTimeseries({
        organizationId: "org_test",
        interval: "1h",
      });

      expect(stats.totalCalls).toBe(4);
      expect(stats.totalErrors).toBe(1);
      expect(stats.avgDurationMs).toBeCloseTo(162.5, 1);
      expect(stats.connectionBreakdown).toHaveLength(2);

      const conn1 = stats.connectionBreakdown.find(
        (item) => item.connectionId === "conn_1",
      );
      const conn2 = stats.connectionBreakdown.find(
        (item) => item.connectionId === "conn_2",
      );

      expect(conn1).toEqual(
        expect.objectContaining({
          connectionId: "conn_1",
          calls: 3,
          errors: 1,
          avgDurationMs: 200,
        }),
      );
      expect(conn1?.errorRate).toBeCloseTo(33.33, 2);

      expect(conn2).toEqual(
        expect.objectContaining({
          connectionId: "conn_2",
          calls: 1,
          errors: 0,
          errorRate: 0,
          avgDurationMs: 50,
        }),
      );
    });
  });

  describe("queryMetricTopToolsTimeseries", () => {
    test("returns top tools and their metric timeseries", async () => {
      const result = await storage.queryMetricTopToolsTimeseries({
        organizationId: "org_test",
        interval: "1h",
        topN: 10,
      });

      expect(result.topTools).toEqual([
        {
          toolName: "TOOL_A",
          connectionId: "conn_1",
          calls: 3,
        },
        {
          toolName: "TOOL_B",
          connectionId: "conn_2",
          calls: 1,
        },
      ]);

      const toolA = result.timeseries.find((row) => row.toolName === "TOOL_A");
      const toolB = result.timeseries.find((row) => row.toolName === "TOOL_B");

      expect(toolA).toEqual(
        expect.objectContaining({
          toolName: "TOOL_A",
          calls: 3,
          errors: 1,
          avg: 200,
        }),
      );
      expect(toolA?.p95).toBeGreaterThan(0);

      expect(toolB).toEqual(
        expect.objectContaining({
          toolName: "TOOL_B",
          calls: 1,
          errors: 0,
          avg: 50,
        }),
      );
    });
  });

  // ============================================================================
  // aggregate()
  // ============================================================================

  describe("aggregate", () => {
    test("sum on JSONPath", async () => {
      const result = await storage.aggregate({
        organizationId: "org_test",
        path: "$.tokens",
        from: "output",
        aggregation: "sum",
      });
      expect(result.value).toBe(500);
    });

    test("groupByColumn groups correctly", async () => {
      const result = await storage.aggregate({
        organizationId: "org_test",
        path: "$.tokens",
        from: "output",
        aggregation: "sum",
        groupByColumn: "tool_name",
      });
      expect(result.groups).toBeDefined();
      expect(result.groups!.length).toBeGreaterThan(0);
      const toolAGroup = result.groups!.find((g) => g.key === "TOOL_A");
      expect(toolAGroup).toBeDefined();
      expect(toolAGroup!.value).toBe(400);
    });

    test("rejects invalid groupByColumn", async () => {
      await expect(
        storage.aggregate({
          organizationId: "org_test",
          path: "$.tokens",
          from: "output",
          aggregation: "sum",
          groupByColumn: "malicious_column" as any,
        }),
      ).rejects.toThrow("Invalid groupByColumn");
    });

    test("rejects invalid JSONPath", async () => {
      await expect(
        storage.aggregate({
          organizationId: "org_test",
          path: "$.foo; DROP TABLE--",
          from: "output",
          aggregation: "sum",
        }),
      ).rejects.toThrow("Invalid JSONPath");
    });

    test("groupBy JSONPath groups correctly", async () => {
      const result = await storage.aggregate({
        organizationId: "org_test",
        path: "$.tokens",
        from: "output",
        aggregation: "sum",
        groupBy: "$.model",
      });
      expect(result.groups).toBeDefined();
      const gpt4Group = result.groups!.find((g) => g.key === "gpt-4");
      expect(gpt4Group).toBeDefined();
      expect(gpt4Group!.value).toBe(200);
    });

    test("timeseries with interval", async () => {
      const result = await storage.aggregate({
        organizationId: "org_test",
        path: "$.tokens",
        from: "output",
        aggregation: "sum",
        interval: "1h",
      });
      expect(result.timeseries).toBeDefined();
      expect(result.timeseries!.length).toBeGreaterThan(0);
      expect(result.timeseries![0]!.value).toBe(500);
    });

    test("rejects invalid interval", async () => {
      await expect(
        storage.aggregate({
          organizationId: "org_test",
          path: "$.tokens",
          from: "output",
          aggregation: "sum",
          interval: "abc",
        }),
      ).rejects.toThrow("Invalid interval");
    });

    test("filters by toolNames", async () => {
      const result = await storage.aggregate({
        organizationId: "org_test",
        path: "$.tokens",
        from: "output",
        aggregation: "sum",
        filters: { toolNames: ["TOOL_B"] },
      });
      expect(result.value).toBe(100);
    });

    test("filters by virtualMcpIds", async () => {
      const result = await storage.aggregate({
        organizationId: "org_test",
        path: "$.tokens",
        from: "output",
        aggregation: "sum",
        filters: { virtualMcpIds: ["vmcp_1"] },
      });
      expect(result.value).toBe(200);
    });

    test("SQL injection in interval is rejected", async () => {
      await expect(
        storage.aggregate({
          organizationId: "org_test",
          path: "$.tokens",
          from: "output",
          aggregation: "sum",
          interval: "1'; DROP TABLE--",
        }),
      ).rejects.toThrow("Invalid interval");
    });
  });

  // ============================================================================
  // countMatched()
  // ============================================================================

  describe("countMatched", () => {
    test("counts rows where JSONPath is non-null", async () => {
      const count = await storage.countMatched({
        organizationId: "org_test",
        path: "$.tokens",
        from: "output",
      });
      expect(count).toBe(4);
    });

    test("returns 0 for nonexistent path", async () => {
      const count = await storage.countMatched({
        organizationId: "org_test",
        path: "$.nonexistent_field",
        from: "output",
      });
      expect(count).toBe(0);
    });

    test("filters by virtualMcpIds", async () => {
      const count = await storage.countMatched({
        organizationId: "org_test",
        path: "$.tokens",
        from: "output",
        filters: { virtualMcpIds: ["vmcp_1"] },
      });
      expect(count).toBe(1);
    });
  });

  // ============================================================================
  // Property filters
  // ============================================================================

  describe("property filters", () => {
    test("exact match on property", async () => {
      const result = await storage.query({
        organizationId: "org_test",
        propertyFilters: {
          properties: { env: "prod" },
        },
      });
      expect(result.total).toBe(1);
      expect(result.logs[0]!.id).toBe("log_4");
    });

    test("key existence filter", async () => {
      const result = await storage.query({
        organizationId: "org_test",
        propertyFilters: {
          propertyKeys: ["team"],
        },
      });
      expect(result.total).toBe(1);
      expect(result.logs[0]!.id).toBe("log_4");
    });

    test("pattern match on property", async () => {
      const result = await storage.query({
        organizationId: "org_test",
        propertyFilters: {
          propertyPatterns: { env: "%rod%" },
        },
      });
      expect(result.total).toBe(1);
      expect(result.logs[0]!.id).toBe("log_4");
    });

    test("SQL injection in property keys is escaped", async () => {
      const result = await storage.query({
        organizationId: "org_test",
        propertyFilters: {
          properties: { "'; DROP TABLE monitoring_logs; --": "value" },
        },
      });
      expect(result.total).toBe(0);
    });

    test("SQL injection in property values is escaped", async () => {
      const result = await storage.query({
        organizationId: "org_test",
        propertyFilters: {
          properties: { env: "' OR '1'='1" },
        },
      });
      expect(result.total).toBe(0);
    });
  });
});

// The existing suite above (metricsFromLogs=false, histogram MetricRow files)
// is the regression control for the local-NDJSON metric path.
describe.skipIf(!duckdbAvailable)(
  "SqlMonitoringStorage (OTLP flat-log source, metricsFromLogs=true)",
  () => {
    let tmpDir: string;
    let engine: DuckDBEngine;
    let storage: SqlMonitoringStorage;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "monitoring-otlp-test-"));
      await writeTestOtlpJson(tmpDir, [
        makeTestOtlpLogRecord({
          id: "span_1",
          tool_name: "TOOL_A",
          duration_ms: 100,
          is_error: 0,
          connection_id: "conn_1",
          output: '{"tokens":42}',
          timestamp: "2026-03-05T12:00:00.000Z",
        }),
        makeTestOtlpLogRecord({
          id: "span_2",
          tool_name: "TOOL_A",
          duration_ms: 300,
          is_error: 1,
          error_message: "timeout",
          connection_id: "conn_1",
          timestamp: "2026-03-05T12:01:00.000Z",
        }),
        makeTestOtlpLogRecord({
          id: "span_3",
          tool_name: "TOOL_B",
          duration_ms: 50,
          is_error: 0,
          connection_id: "conn_2",
          timestamp: "2026-03-05T12:02:00.000Z",
        }),
      ]);

      engine = new DuckDBEngine();
      const otlpSource = buildOtlpFlatSourceFromGlob(`${tmpDir}/**/*.json`);
      storage = new SqlMonitoringStorage(
        engine,
        () => otlpSource,
        engine,
        () => otlpSource,
        "duckdb",
        true, // metricsFromLogs
      );
    });

    afterAll(async () => {
      await engine.destroy();
      await rm(tmpDir, { recursive: true, force: true });
    });

    test("query returns flattened log rows", async () => {
      const result = await storage.query({ organizationId: "org_test" });
      expect(result.total).toBe(3);
      expect(result.logs.map((l) => l.id).sort()).toEqual([
        "span_1",
        "span_2",
        "span_3",
      ]);
      const errored = result.logs.find((l) => l.id === "span_2")!;
      expect(errored.isError).toBe(true);
      expect(errored.errorMessage).toBe("timeout");
    });

    test("getById returns a single flattened row", async () => {
      const log = await storage.getById("org_test", "span_1");
      expect(log?.toolName).toBe("TOOL_A");
      expect(log?.durationMs).toBe(100);
    });

    test("getStats aggregates over flat rows", async () => {
      const stats = await storage.getStats({ organizationId: "org_test" });
      expect(stats.totalCalls).toBe(3);
      expect(stats.errorRate).toBeCloseTo(1 / 3, 5);
      expect(stats.avgDurationMs).toBeCloseTo(150, 5);
    });

    test("queryMetricTimeseries derives metrics from log rows", async () => {
      const result = await storage.queryMetricTimeseries({
        organizationId: "org_test",
        interval: "1d",
        startDate: new Date("2026-03-01T00:00:00.000Z"),
        endDate: new Date("2026-03-10T00:00:00.000Z"),
      });
      expect(result.totalCalls).toBe(3);
      expect(result.totalErrors).toBe(1);
      expect(result.avgDurationMs).toBeCloseTo(150, 5);
      expect(result.p95DurationMs).toBeGreaterThan(0);
      expect(result.connectionBreakdown.length).toBe(2);
    });

    test("queryMetricTopToolsTimeseries derives top tools from log rows", async () => {
      const result = await storage.queryMetricTopToolsTimeseries({
        organizationId: "org_test",
        interval: "1d",
        startDate: new Date("2026-03-01T00:00:00.000Z"),
        endDate: new Date("2026-03-10T00:00:00.000Z"),
      });
      expect(result.topTools.length).toBe(2);
      // TOOL_A has 2 calls, TOOL_B has 1 → TOOL_A ranks first
      expect(result.topTools[0]!.toolName).toBe("TOOL_A");
      expect(result.topTools[0]!.calls).toBe(2);
    });
  },
);

// ============================================================================
// Date-range threading — the source factory receives the window so the GCS
// OTLP path can partition-prune. Stubbed engine, so it needs no DuckDB.
// ============================================================================

describe("SqlMonitoringStorage forwards the date range to its source factory", () => {
  function recordingStorage() {
    const ranges: Array<MonitoringDateRange | undefined> = [];
    const factory = (_orgId: string, range?: MonitoringDateRange) => {
      ranges.push(range);
      return "src";
    };
    const engine: QueryEngine = { query: async () => [] };
    const storage = new SqlMonitoringStorage(
      engine,
      factory,
      engine,
      factory,
      "duckdb",
      true, // metricsFromLogs (the GCS OTLP shape)
    );
    return { storage, ranges };
  }

  const startDate = new Date("2026-03-15T00:00:00.000Z");
  const endDate = new Date("2026-03-16T00:00:00.000Z");

  test("queryMetricTimeseries forwards startDate/endDate", async () => {
    const { storage, ranges } = recordingStorage();
    await storage.queryMetricTimeseries({
      organizationId: "org_test",
      interval: "1d",
      startDate,
      endDate,
    });
    expect(
      ranges.some((r) => r?.startDate === startDate && r?.endDate === endDate),
    ).toBe(true);
  });

  test("query forwards startDate/endDate", async () => {
    const { storage, ranges } = recordingStorage();
    await storage.query({ organizationId: "org_test", startDate, endDate });
    expect(ranges[0]?.startDate).toBe(startDate);
    expect(ranges[0]?.endDate).toBe(endDate);
  });

  test("queryLlmUsageStats forwards startDate/endDate", async () => {
    const { storage, ranges } = recordingStorage();
    await storage.queryLlmUsageStats({
      organizationId: "org_test",
      connectionId: "conn_1",
      interval: "1d",
      startDate,
      endDate,
    });
    expect(
      ranges.some((r) => r?.startDate === startDate && r?.endDate === endDate),
    ).toBe(true);
  });
});

// ============================================================================
// queryLlmUsageStats — token + cost aggregation from log rows
// ============================================================================

describe.skipIf(!duckdbAvailable)(
  "SqlMonitoringStorage.queryLlmUsageStats",
  () => {
    let tmpDir: string;
    let engine: DuckDBEngine;
    let storage: SqlMonitoringStorage;

    const range = {
      startDate: new Date("2026-03-01T00:00:00.000Z"),
      endDate: new Date("2026-03-10T00:00:00.000Z"),
    };

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "monitoring-llm-test-"));
      const dataDir = join(tmpDir, "2026", "03", "06", "12");
      await mkdir(dataDir, { recursive: true });
      engine = new DuckDBEngine();
      const sourceFactory = (_orgId: string) =>
        `read_ndjson('${dataDir}/*.ndjson', auto_detect=true)`;
      storage = new SqlMonitoringStorage(
        engine,
        sourceFactory,
        engine,
        sourceFactory,
        "duckdb",
      );

      // Usage/cost are read from `properties` (strings), not `output`.
      const llmRow = (
        id: string,
        model: string,
        userId: string,
        usage: { in: number; out: number; total: number; cost?: number },
        durationMs: number,
        isError: 0 | 1,
        ts: string,
      ) =>
        makeTestMonitoringRow({
          id,
          tool_name: model,
          duration_ms: durationMs,
          is_error: isError,
          organization_id: "org_test",
          connection_id: "decopilot",
          connection_title: "Decopilot",
          properties: JSON.stringify({
            log_type: "llm_call",
            input_tokens: String(usage.in),
            output_tokens: String(usage.out),
            total_tokens: String(usage.total),
            ...(usage.cost !== undefined ? { cost: String(usage.cost) } : {}),
          }),
          timestamp: ts,
          request_id: id,
          user_id: userId,
        });

      await writeTestNDJSON(dataDir, [
        llmRow(
          "llm_1",
          "model-a",
          "user_1",
          { in: 10, out: 5, total: 15, cost: 0.01 },
          100,
          0,
          "2026-03-05T12:00:00.000Z",
        ),
        llmRow(
          "llm_2",
          "model-a",
          "user_1",
          { in: 20, out: 10, total: 30, cost: 0.02 },
          200,
          0,
          "2026-03-05T12:01:00.000Z",
        ),
        llmRow(
          "llm_3",
          "model-b",
          "user_2",
          { in: 4, out: 2, total: 6, cost: 0.005 },
          50,
          1,
          "2026-03-05T12:02:00.000Z",
        ),
        // Row without cost (provider didn't report it) — cost contributes 0.
        llmRow(
          "llm_legacy",
          "model-a",
          "user_1",
          { in: 7, out: 3, total: 10 },
          80,
          0,
          "2026-03-05T12:03:00.000Z",
        ),
      ]);
      // Non-LLM noise: different connection, must be excluded from LLM usage.
      await writeFile(
        join(dataDir, "noise.ndjson"),
        JSON.stringify(
          makeTestMonitoringRow({
            id: "noise_2",
            tool_name: "TOOL_X",
            duration_ms: 10,
            is_error: 0,
            organization_id: "org_test",
            connection_id: "conn_other",
            connection_title: "Other",
            properties: JSON.stringify({
              input_tokens: "500",
              output_tokens: "500",
              total_tokens: "1000",
              cost: "5",
            }),
            timestamp: "2026-03-05T12:05:00.000Z",
            request_id: "noise_2",
            user_id: "user_1",
          }),
        ) + "\n",
        { mode: 0o600 },
      );
    });

    afterAll(async () => {
      await engine.destroy();
      await rm(tmpDir, { recursive: true, force: true });
    });

    test("aggregates tokens and cost across all members", async () => {
      const result = await storage.queryLlmUsageStats({
        organizationId: "org_test",
        interval: "1d",
        connectionId: "decopilot",
        ...range,
      });

      // 4 decopilot rows (llm_1, llm_2, llm_3, llm_legacy); conn_other excluded.
      expect(result.totalCalls).toBe(4);
      expect(result.totalErrors).toBe(1);
      // input: 10 + 20 + 4 + 7
      expect(result.totalInputTokens).toBe(41);
      // output: 5 + 10 + 2 + 3
      expect(result.totalOutputTokens).toBe(20);
      // total: 15 + 30 + 6 + 10
      expect(result.totalTokens).toBe(61);
      // cost: 0.01 + 0.02 + 0.005 + 0 (legacy)
      expect(result.totalCostUsd).toBeCloseTo(0.035, 5);
      expect(result.timeseries.length).toBeGreaterThan(0);
    });

    test("filters by member (userIds)", async () => {
      const result = await storage.queryLlmUsageStats({
        organizationId: "org_test",
        interval: "1d",
        connectionId: "decopilot",
        userIds: ["user_2"],
        ...range,
      });
      // Only llm_3 belongs to user_2.
      expect(result.totalCalls).toBe(1);
      expect(result.totalInputTokens).toBe(4);
      expect(result.totalOutputTokens).toBe(2);
      expect(result.totalCostUsd).toBeCloseTo(0.005, 6);
    });

    test("ranks top models by calls with per-model token/cost", async () => {
      const result = await storage.queryLlmUsageStats({
        organizationId: "org_test",
        interval: "1d",
        connectionId: "decopilot",
        topN: 5,
        ...range,
      });
      // model-a: llm_1, llm_2, llm_legacy → 3 calls; ranks first.
      expect(result.topTools[0]!.toolName).toBe("model-a");
      expect(result.topTools[0]!.calls).toBe(3);
      // model-a tokens: in 10+20+7 = 37, out 5+10+3 = 18, cost 0.01+0.02 = 0.03
      expect(result.topTools[0]!.inputTokens).toBe(37);
      expect(result.topTools[0]!.outputTokens).toBe(18);
      expect(result.topTools[0]!.costUsd).toBeCloseTo(0.03, 6);
      expect(result.topTools[0]!.connectionId).toBe("decopilot");
    });

    test("rows without provider cost still count tokens (cost = 0)", async () => {
      const result = await storage.queryLlmUsageStats({
        organizationId: "org_test",
        interval: "1d",
        connectionId: "decopilot",
        userIds: ["user_1"],
        ...range,
      });
      // user_1: llm_1, llm_2, llm_legacy.
      // input: 10 + 20 + 7 = 37
      expect(result.totalInputTokens).toBe(37);
      // cost: 0.01 + 0.02 + 0 (legacy) = 0.03
      expect(result.totalCostUsd).toBeCloseTo(0.03, 5);
    });
  },
);

// ============================================================================
// queryThreadUsage — per-thread token + cost from properties.thread_id
// ============================================================================

describe.skipIf(!duckdbAvailable)(
  "SqlMonitoringStorage.queryThreadUsage",
  () => {
    let tmpDir: string;
    let engine: DuckDBEngine;
    let storage: SqlMonitoringStorage;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "monitoring-thr-test-"));
      const dataDir = join(tmpDir, "2026", "03", "06", "12");
      await mkdir(dataDir, { recursive: true });
      engine = new DuckDBEngine();
      const sourceFactory = (_orgId: string) =>
        `read_ndjson('${dataDir}/*.ndjson', auto_detect=true)`;
      storage = new SqlMonitoringStorage(
        engine,
        sourceFactory,
        engine,
        sourceFactory,
        "duckdb",
      );

      const row = (
        id: string,
        threadId: string,
        usage: { in: number; out: number; total: number; cost: number },
        ts: string,
      ) =>
        makeTestMonitoringRow({
          id,
          tool_name: "model-a",
          duration_ms: 100,
          is_error: 0,
          organization_id: "org_test",
          connection_id: "decopilot",
          connection_title: "Decopilot",
          properties: JSON.stringify({
            thread_id: threadId,
            input_tokens: String(usage.in),
            output_tokens: String(usage.out),
            total_tokens: String(usage.total),
            cost: String(usage.cost),
          }),
          timestamp: ts,
          request_id: id,
          user_id: "user_1",
        });

      await writeTestNDJSON(dataDir, [
        row(
          "c1",
          "thread_a",
          { in: 10, out: 5, total: 15, cost: 0.01 },
          "2026-03-05T12:00:00.000Z",
        ),
        row(
          "c2",
          "thread_a",
          { in: 20, out: 10, total: 30, cost: 0.02 },
          "2026-03-05T12:01:00.000Z",
        ),
        row(
          "c3",
          "thread_b",
          { in: 4, out: 2, total: 6, cost: 0.005 },
          "2026-03-05T12:02:00.000Z",
        ),
      ]);
    });

    afterAll(async () => {
      await engine.destroy();
      await rm(tmpDir, { recursive: true, force: true });
    });

    test("aggregates tokens + cost per thread for requested ids", async () => {
      const rows = await storage.queryThreadUsage({
        organizationId: "org_test",
        connectionId: "decopilot",
        threadIds: ["thread_a", "thread_b"],
        startDate: new Date("2026-03-01T00:00:00.000Z"),
        endDate: new Date("2026-03-10T00:00:00.000Z"),
      });
      const byThread = new Map(rows.map((r) => [r.threadId, r]));

      const a = byThread.get("thread_a")!;
      expect(a.calls).toBe(2);
      expect(a.totalTokens).toBe(45); // 15 + 30
      expect(a.inputTokens).toBe(30); // 10 + 20
      expect(a.costUsd).toBeCloseTo(0.03, 6);

      const b = byThread.get("thread_b")!;
      expect(b.calls).toBe(1);
      expect(b.totalTokens).toBe(6);
      expect(b.costUsd).toBeCloseTo(0.005, 6);
    });

    test("excludes threads not in the requested id list", async () => {
      const rows = await storage.queryThreadUsage({
        organizationId: "org_test",
        connectionId: "decopilot",
        threadIds: ["thread_a"],
      });
      expect(rows.length).toBe(1);
      expect(rows[0]!.threadId).toBe("thread_a");
    });

    test("returns empty for empty id list", async () => {
      const rows = await storage.queryThreadUsage({
        organizationId: "org_test",
        connectionId: "decopilot",
        threadIds: [],
      });
      expect(rows).toEqual([]);
    });
  },
);
