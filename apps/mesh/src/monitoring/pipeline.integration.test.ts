/**
 * Integration test: Span creation -> NDJSON write -> chdb (embedded ClickHouse) query
 */
import { describe, it, expect, afterAll } from "bun:test";
import { NDJSONSpanExporter } from "./ndjson-span-exporter";
import { ClickHouseMonitoringStorage } from "../storage/monitoring-clickhouse";
import { createMonitoringEngine } from "./query-engine";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportResultCode } from "@opentelemetry/core";
import { MESH_ATTR } from "./schema";
import { makeTestMonitoringSpan, findNDJSONFiles } from "./test-utils";

describe("Monitoring Pipeline Integration", () => {
  let tmpDir: string;
  let engineToDestroy: { destroy?: () => void | Promise<void> } | null = null;

  afterAll(async () => {
    if (engineToDestroy?.destroy) await engineToDestroy.destroy();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write spans to NDJSON and query them via chdb", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pipeline-integration-"));

    // 1. Create exporter and write spans
    const exporter = new NDJSONSpanExporter({
      basePath: tmpDir,
      flushThreshold: 5,
      flushIntervalMs: 0,
    });

    const spans = [
      makeTestMonitoringSpan({
        [MESH_ATTR.TOOL_NAME]: "TOOL_X",
        [MESH_ATTR.ORGANIZATION_ID]: "org_int",
        [MESH_ATTR.TOOL_OUTPUT]: '{"tokens": 42, "model": "claude"}',
      }),
      makeTestMonitoringSpan({
        [MESH_ATTR.TOOL_NAME]: "TOOL_X",
        [MESH_ATTR.ORGANIZATION_ID]: "org_int",
        [MESH_ATTR.TOOL_OUTPUT]: '{"tokens": 42, "model": "claude"}',
      }),
      makeTestMonitoringSpan({
        [MESH_ATTR.TOOL_NAME]: "TOOL_Y",
        [MESH_ATTR.ORGANIZATION_ID]: "org_int",
        [MESH_ATTR.TOOL_OUTPUT]: '{"tokens": 42, "model": "claude"}',
      }),
      makeTestMonitoringSpan({
        [MESH_ATTR.TOOL_NAME]: "TOOL_X",
        [MESH_ATTR.ORGANIZATION_ID]: "org_int",
        [MESH_ATTR.TOOL_OUTPUT]: '{"tokens": 42, "model": "claude"}',
      }),
      makeTestMonitoringSpan({
        [MESH_ATTR.TOOL_NAME]: "TOOL_Z",
        [MESH_ATTR.ORGANIZATION_ID]: "org_other",
      }),
    ];

    const result = await new Promise<{ code: number }>((resolve) => {
      exporter.export(spans as any, resolve);
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
