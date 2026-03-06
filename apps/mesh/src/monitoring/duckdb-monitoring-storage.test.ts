import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { DuckDBMonitoringStorage } from "./duckdb-monitoring-storage";
import { DuckDBProvider } from "./duckdb-provider";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBatchFilePath } from "./parquet-paths";
import { CREATE_STAGING_TABLE_SQL } from "./parquet-schema";
import type { MonitoringLog } from "../storage/types";

/** Write test data as a Parquet file using DuckDB */
async function writeTestParquet(
  duckdb: DuckDBProvider,
  basePath: string,
  logs: Array<Partial<MonitoringLog> & { organizationId: string }>,
  batchNumber: number = 1,
  /** Date used for the partition directory (defaults to first log's timestamp) */
  partitionDate?: Date,
): Promise<string> {
  await duckdb.run("DROP TABLE IF EXISTS test_staging");
  await duckdb.run(
    CREATE_STAGING_TABLE_SQL.replace("monitoring_staging", "test_staging"),
  );

  for (const log of logs) {
    const ts =
      log.timestamp instanceof Date
        ? log.timestamp
        : new Date(log.timestamp ?? Date.now());

    const reqId = log.requestId ?? `req_${Math.random().toString(36).slice(2)}`;

    await duckdb.run(
      `INSERT INTO test_staging VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reqId,
      log.organizationId,
      log.connectionId ?? "conn_default",
      log.connectionTitle ?? "Default Connection",
      log.toolName ?? "default_tool",
      log.input ? JSON.stringify(log.input) : "{}",
      log.output ? JSON.stringify(log.output) : "{}",
      log.isError ?? false,
      log.errorMessage ?? null,
      log.durationMs ?? 100,
      ts.toISOString(),
      log.userId ?? null,
      reqId,
      log.userAgent ?? null,
      log.virtualMcpId ?? null,
      log.properties ? JSON.stringify(log.properties) : null,
    );
  }

  // Use the provided partition date (or the first log's timestamp) so the
  // glob narrowing based on date range matches the file location.
  const fileDate =
    partitionDate ??
    (logs[0]?.timestamp instanceof Date
      ? logs[0].timestamp
      : new Date(logs[0]?.timestamp ?? Date.now()));
  const filePath = getBatchFilePath(basePath, fileDate, batchNumber);
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await duckdb.run(
    `COPY test_staging TO '${filePath}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
  );
  await duckdb.run("DROP TABLE test_staging");
  return filePath;
}

describe("DuckDBMonitoringStorage", () => {
  let basePath: string;
  let writerDb: DuckDBProvider;
  let storage: DuckDBMonitoringStorage;

  beforeAll(async () => {
    basePath = join(tmpdir(), `duckdb-monitoring-test-${Date.now()}`);
    await mkdir(basePath, { recursive: true });
    writerDb = new DuckDBProvider(":memory:");

    await writeTestParquet(
      writerDb,
      basePath,
      [
        {
          organizationId: "org_1",
          connectionId: "conn_a",
          connectionTitle: "Connection A",
          toolName: "tool_alpha",
          input: { arg: "value" } as Record<string, unknown>,
          output: {
            result: "ok",
            usage: { total_tokens: 100 },
          } as Record<string, unknown>,
          isError: false,
          durationMs: 100,
          timestamp: new Date("2026-01-01T10:00:00Z"),
          requestId: "req_1",
          userId: "user_1",
          properties: { env: "production" } as Record<string, string>,
        },
        {
          organizationId: "org_1",
          connectionId: "conn_a",
          connectionTitle: "Connection A",
          toolName: "tool_beta",
          output: { error: "fail" } as Record<string, unknown>,
          isError: true,
          errorMessage: "Something failed",
          durationMs: 200,
          timestamp: new Date("2026-01-01T11:00:00Z"),
          requestId: "req_2",
          userId: "user_1",
        },
        {
          organizationId: "org_1",
          connectionId: "conn_b",
          connectionTitle: "Connection B",
          toolName: "tool_alpha",
          output: {
            result: "ok",
            usage: { total_tokens: 250 },
          } as Record<string, unknown>,
          isError: false,
          durationMs: 150,
          timestamp: new Date("2026-01-01T12:00:00Z"),
          requestId: "req_3",
          virtualMcpId: "vmcp_1",
          properties: { env: "staging" } as Record<string, string>,
        },
        {
          organizationId: "org_2",
          connectionId: "conn_c",
          connectionTitle: "Connection C",
          toolName: "tool_gamma",
          isError: false,
          durationMs: 50,
          timestamp: new Date("2026-01-01T13:00:00Z"),
          requestId: "req_4",
        },
      ],
      1,
    );

    storage = new DuckDBMonitoringStorage(basePath);
  });

  afterAll(async () => {
    await storage.close();
    await writerDb.close();
    await rm(basePath, { recursive: true, force: true });
  });

  // --- query() ---

  describe("query", () => {
    it("filters by organizationId", async () => {
      const { logs, total } = await storage.query({
        organizationId: "org_1",
      });
      expect(total).toBe(3);
      expect(logs.length).toBe(3);
      expect(logs.every((l) => l.organizationId === "org_1")).toBe(true);
    });

    it("filters by connectionId", async () => {
      const { logs } = await storage.query({
        organizationId: "org_1",
        connectionId: "conn_a",
      });
      expect(logs.length).toBe(2);
      expect(logs.every((l) => l.connectionId === "conn_a")).toBe(true);
    });

    it("filters by toolName", async () => {
      const { logs } = await storage.query({
        organizationId: "org_1",
        toolName: "tool_alpha",
      });
      expect(logs.length).toBe(2);
      expect(logs.every((l) => l.toolName === "tool_alpha")).toBe(true);
    });

    it("filters by isError", async () => {
      const { logs } = await storage.query({
        organizationId: "org_1",
        isError: true,
      });
      expect(logs.length).toBe(1);
      expect(logs[0]!.toolName).toBe("tool_beta");
    });

    it("filters by date range", async () => {
      const { logs } = await storage.query({
        organizationId: "org_1",
        startDate: new Date("2026-01-01T10:30:00Z"),
        endDate: new Date("2026-01-01T11:30:00Z"),
      });
      expect(logs.length).toBe(1);
      expect(logs[0]!.toolName).toBe("tool_beta");
    });

    it("filters by virtualMcpId", async () => {
      const { logs } = await storage.query({
        organizationId: "org_1",
        virtualMcpId: "vmcp_1",
      });
      expect(logs.length).toBe(1);
      expect(logs[0]!.connectionId).toBe("conn_b");
    });

    it("excludes connectionIds", async () => {
      const { logs } = await storage.query({
        organizationId: "org_1",
        excludeConnectionIds: ["conn_a"],
      });
      expect(logs.length).toBe(1);
      expect(logs[0]!.connectionId).toBe("conn_b");
    });

    it("paginates results", async () => {
      const { logs, total } = await storage.query({
        organizationId: "org_1",
        limit: 2,
        offset: 0,
      });
      expect(logs.length).toBe(2);
      expect(total).toBe(3);
    });

    it("returns results ordered by timestamp descending", async () => {
      const { logs } = await storage.query({ organizationId: "org_1" });
      for (let i = 1; i < logs.length; i++) {
        const prev = new Date(logs[i - 1]!.timestamp).getTime();
        const curr = new Date(logs[i]!.timestamp).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    });

    it("filters by property exact match", async () => {
      const { logs } = await storage.query({
        organizationId: "org_1",
        propertyFilters: {
          properties: { env: "production" },
        },
      });
      expect(logs.length).toBe(1);
      expect(logs[0]!.connectionId).toBe("conn_a");
    });

    it("filters by property key existence", async () => {
      const { logs } = await storage.query({
        organizationId: "org_1",
        propertyFilters: {
          propertyKeys: ["env"],
        },
      });
      expect(logs.length).toBe(2);
    });
  });

  // --- getStats() ---

  describe("getStats", () => {
    it("calculates correct stats", async () => {
      const stats = await storage.getStats({ organizationId: "org_1" });
      expect(stats.totalCalls).toBe(3);
      expect(stats.errorRate).toBeCloseTo(1 / 3, 2);
      expect(stats.avgDurationMs).toBeCloseTo(150, 0);
    });

    it("filters stats by date range", async () => {
      const stats = await storage.getStats({
        organizationId: "org_1",
        startDate: new Date("2026-01-01T10:00:00Z"),
        endDate: new Date("2026-01-01T10:30:00Z"),
      });
      expect(stats.totalCalls).toBe(1);
      expect(stats.errorRate).toBe(0);
      expect(stats.avgDurationMs).toBe(100);
    });

    it("returns zero stats for unknown org", async () => {
      const stats = await storage.getStats({
        organizationId: "org_unknown",
      });
      expect(stats.totalCalls).toBe(0);
      expect(stats.errorRate).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
    });
  });

  // --- aggregate() ---

  describe("aggregate", () => {
    it("returns scalar aggregation (sum)", async () => {
      const result = await storage.aggregate({
        organizationId: "org_1",
        path: "$.usage.total_tokens",
        from: "output",
        aggregation: "sum",
      });
      expect(result.value).toBe(350);
    });

    it("returns scalar aggregation (avg)", async () => {
      const result = await storage.aggregate({
        organizationId: "org_1",
        path: "$.usage.total_tokens",
        from: "output",
        aggregation: "avg",
      });
      expect(result.value).toBe(175);
    });

    it("returns count_all", async () => {
      const result = await storage.aggregate({
        organizationId: "org_1",
        path: "$",
        from: "output",
        aggregation: "count_all",
      });
      expect(result.value).toBe(3);
    });

    it("returns count (non-null path values)", async () => {
      const result = await storage.aggregate({
        organizationId: "org_1",
        path: "$.usage.total_tokens",
        from: "output",
        aggregation: "count",
      });
      expect(result.value).toBe(2);
    });

    it("groups by column", async () => {
      const result = await storage.aggregate({
        organizationId: "org_1",
        path: "$",
        from: "output",
        aggregation: "count_all",
        groupByColumn: "connection_id",
      });
      expect(result.groups).toBeDefined();
      expect(result.groups!.length).toBe(2);
      const connA = result.groups!.find((g) => g.key === "conn_a");
      expect(connA?.value).toBe(2);
    });

    it("groups by JSONPath", async () => {
      const result = await storage.aggregate({
        organizationId: "org_1",
        path: "$",
        from: "output",
        aggregation: "count_all",
        groupBy: "$.result",
      });
      expect(result.groups).toBeDefined();
    });

    it("returns timeseries", async () => {
      const result = await storage.aggregate({
        organizationId: "org_1",
        path: "$",
        from: "output",
        aggregation: "count_all",
        interval: "1h",
      });
      expect(result.timeseries).toBeDefined();
      expect(result.timeseries!.length).toBeGreaterThan(0);
    });

    it("applies filters to aggregation", async () => {
      const result = await storage.aggregate({
        organizationId: "org_1",
        path: "$.usage.total_tokens",
        from: "output",
        aggregation: "sum",
        filters: {
          connectionIds: ["conn_b"],
        },
      });
      expect(result.value).toBe(250);
    });

    it("limits grouped results", async () => {
      const result = await storage.aggregate({
        organizationId: "org_1",
        path: "$",
        from: "output",
        aggregation: "count_all",
        groupByColumn: "tool_name",
        limit: 1,
      });
      expect(result.groups!.length).toBe(1);
      expect(result.groups![0]!.key).toBe("tool_alpha");
    });
  });

  // --- countMatched() ---

  describe("countMatched", () => {
    it("counts rows where JSONPath value is non-null", async () => {
      const count = await storage.countMatched({
        organizationId: "org_1",
        path: "$.usage.total_tokens",
        from: "output",
      });
      expect(count).toBe(2);
    });

    it("returns 0 for non-existent path", async () => {
      const count = await storage.countMatched({
        organizationId: "org_1",
        path: "$.nonexistent.path",
        from: "output",
      });
      expect(count).toBe(0);
    });

    it("applies filters", async () => {
      const count = await storage.countMatched({
        organizationId: "org_1",
        path: "$.usage.total_tokens",
        from: "output",
        filters: {
          connectionIds: ["conn_a"],
        },
      });
      expect(count).toBe(1);
    });
  });
});
