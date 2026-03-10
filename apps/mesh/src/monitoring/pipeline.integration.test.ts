/**
 * Integration test: Log record creation -> NDJSON write -> chdb (embedded ClickHouse) query
 */
import { describe, it, expect, afterAll } from "bun:test";
import { NDJSONLogExporter } from "./ndjson-log-exporter";
import { ClickHouseMonitoringStorage } from "../storage/monitoring-clickhouse";
import { createMonitoringEngine } from "./query-engine";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportResultCode } from "@opentelemetry/core";
import { MONITORING_LOG_ATTR } from "./schema";
import { makeTestMonitoringLogRecord, findNDJSONFiles } from "./test-utils";

let chdbAvailable = false;
try {
  require("chdb");
  chdbAvailable = true;
} catch {}

describe.skipIf(!chdbAvailable)("Monitoring Pipeline Integration", () => {
  let tmpDir: string;
  let engineToDestroy: { destroy?: () => void | Promise<void> } | null = null;

  afterAll(async () => {
    if (engineToDestroy?.destroy) await engineToDestroy.destroy();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write log records to NDJSON and query them via chdb", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pipeline-integration-"));

    // 1. Create exporter and write log records
    const exporter = new NDJSONLogExporter({
      basePath: tmpDir,
      flushThreshold: 5,
      flushIntervalMs: 0,
    });

    const records = [
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_X",
        [MONITORING_LOG_ATTR.ORGANIZATION_ID]: "org_int",
        [MONITORING_LOG_ATTR.OUTPUT]: '{"tokens": 42, "model": "claude"}',
      }),
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_X",
        [MONITORING_LOG_ATTR.ORGANIZATION_ID]: "org_int",
        [MONITORING_LOG_ATTR.OUTPUT]: '{"tokens": 42, "model": "claude"}',
      }),
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_Y",
        [MONITORING_LOG_ATTR.ORGANIZATION_ID]: "org_int",
        [MONITORING_LOG_ATTR.OUTPUT]: '{"tokens": 42, "model": "claude"}',
      }),
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_X",
        [MONITORING_LOG_ATTR.ORGANIZATION_ID]: "org_int",
        [MONITORING_LOG_ATTR.OUTPUT]: '{"tokens": 42, "model": "claude"}',
      }),
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_Z",
        [MONITORING_LOG_ATTR.ORGANIZATION_ID]: "org_other",
      }),
    ];

    const result = await new Promise<{ code: number }>((resolve) => {
      exporter.export(records as any, resolve);
    });
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    await exporter.shutdown();

    // 2. Verify NDJSON files are valid
    const files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBeGreaterThanOrEqual(1);

    const content = await readFile(files[0]!, "utf-8");
    const lines = content.trim().split("\n");
    for (const line of lines) {
      JSON.parse(line); // Should not throw
    }

    // 3. Query via ClickHouseMonitoringStorage (chdb engine for local NDJSON)
    const { engine, source } = createMonitoringEngine({ basePath: tmpDir });
    engineToDestroy = engine;
    const storage = new ClickHouseMonitoringStorage(engine, source);

    // Basic query
    const queryResult = await storage.query({ organizationId: "org_int" });
    expect(queryResult.total).toBe(4);

    // Stats
    const stats = await storage.getStats({ organizationId: "org_int" });
    expect(stats.totalCalls).toBe(4);
    expect(stats.errorRate).toBe(0);

    // Aggregation with groupBy
    const aggResult = await storage.aggregate({
      organizationId: "org_int",
      path: "$.tokens",
      from: "output",
      aggregation: "sum",
      groupByColumn: "tool_name",
    });
    expect(aggResult.groups).toBeDefined();
    const toolX = aggResult.groups!.find((g) => g.key === "TOOL_X");
    expect(toolX).toBeDefined();
    expect(toolX!.value).toBe(126); // 42 * 3

    // Count matched
    const count = await storage.countMatched({
      organizationId: "org_int",
      path: "$.model",
      from: "output",
    });
    expect(count).toBe(4);

    // Organization isolation
    const orgResult = await storage.query({ organizationId: "org_int" });
    const orgIds = new Set(orgResult.logs.map((l) => l.organizationId));
    expect(orgIds.has("org_other")).toBe(false);
  });
});
