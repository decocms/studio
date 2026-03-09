import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChdbEngine } from "../monitoring/query-engine";
import {
  makeTestMonitoringRow,
  writeTestNDJSON,
} from "../monitoring/test-utils";
import { ClickHouseMonitoringStorage } from "./monitoring-clickhouse";

let tmpDir: string;
let engine: ChdbEngine;
let storage: ClickHouseMonitoringStorage;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "monitoring-ch-test-"));
  // Create subdirectory matching NDJSON exporter structure
  const dataDir = join(tmpDir, "2026", "03", "06", "12");
  await mkdir(dataDir, { recursive: true });
  engine = new ChdbEngine();

  const source = `file('${tmpDir}/**/*.ndjson', 'JSONEachRow')`;
  storage = new ClickHouseMonitoringStorage(engine, source);

  // Write test data
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
    // Should be ordered by timestamp DESC
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

    // No overlap
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
    // 1 error out of 4 = 0.25
    expect(stats.errorRate).toBeCloseTo(0.25, 2);
    // avg of 100, 200, 50, 300 = 162.5
    expect(stats.avgDurationMs).toBeCloseTo(162.5, 1);
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
    // log_1 has {"tokens": 100}, log_4 has {"tokens": 200} — total 300
    // log_2 output is default {"tokens": 100}, log_3 output is default {"tokens": 100}
    // Actually let's check — makeTestMonitoringRow default output is '{"tokens": 100}'
    // log_4 overrides to '{"tokens":200,"model":"gpt-4"}'
    // So: 100 + 100 + 100 + 200 = 500
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
    // TOOL_A: log_1(100) + log_2(100) + log_4(200) = 400
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
    // Only log_4 has model="gpt-4"
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
    // All logs are in the same hour, so should have one bucket
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
    // TOOL_B: log_3 has default output {"tokens": 100}
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
    // Only log_4 has vmcp_1, tokens=200
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
    // All 4 org_test rows have "tokens" in output (default + override)
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
