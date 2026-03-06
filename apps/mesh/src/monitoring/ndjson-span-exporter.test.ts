import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { NDJSONSpanExporter } from "./ndjson-span-exporter";
import { ExportResultCode } from "@opentelemetry/core";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESH_ATTR } from "./schema";
import { makeTestMonitoringSpan, findNDJSONFiles } from "./test-utils";

describe("NDJSONSpanExporter", () => {
  let tmpDir: string;
  let exporter: NDJSONSpanExporter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ndjson-exporter-test-"));
    exporter = new NDJSONSpanExporter({
      basePath: tmpDir,
      flushThreshold: 3,
      flushIntervalMs: 60_000, // High so it doesn't auto-flush
    });
  });

  afterEach(async () => {
    await exporter.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should implement SpanExporter interface", () => {
    expect(typeof exporter.export).toBe("function");
    expect(typeof exporter.shutdown).toBe("function");
    expect(typeof exporter.forceFlush).toBe("function");
  });

  it("should buffer spans and flush when threshold reached", async () => {
    const spans = [
      makeTestMonitoringSpan({ [MESH_ATTR.TOOL_NAME]: "TOOL_A" }),
      makeTestMonitoringSpan({ [MESH_ATTR.TOOL_NAME]: "TOOL_B" }),
      makeTestMonitoringSpan({ [MESH_ATTR.TOOL_NAME]: "TOOL_C" }),
    ];

    const result = await new Promise<{ code: number }>((resolve) => {
      exporter.export(spans as any, resolve);
    });

    expect(result.code).toBe(ExportResultCode.SUCCESS);

    const files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]).toEndWith(".ndjson");
  });

  it("should write valid NDJSON (one JSON object per line)", async () => {
    const spans = Array.from({ length: 3 }, (_, i) =>
      makeTestMonitoringSpan({ [MESH_ATTR.TOOL_NAME]: `TOOL_${i}` }),
    );

    await new Promise<{ code: number }>((resolve) => {
      exporter.export(spans as any, resolve);
    });

    const files = await findNDJSONFiles(tmpDir);
    const content = await readFile(files[0], "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.id).toBeDefined();
      expect(parsed.tool_name).toBeDefined();
      expect(parsed.organization_id).toBeDefined();
      expect(parsed.timestamp).toBeDefined();
    }
  });

  it("should flush remaining spans on shutdown", async () => {
    const spans = [
      makeTestMonitoringSpan({ [MESH_ATTR.TOOL_NAME]: "TOOL_SHUTDOWN" }),
    ];

    await new Promise<{ code: number }>((resolve) => {
      exporter.export(spans as any, resolve);
    });

    // Not yet flushed (below threshold)
    let files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(0);

    await exporter.shutdown();

    files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);
  });

  it("should write to time-partitioned paths with UUID filenames", async () => {
    const spans = Array.from({ length: 3 }, () =>
      makeTestMonitoringSpan({ [MESH_ATTR.TOOL_NAME]: "TOOL_TIME" }),
    );

    await new Promise<{ code: number }>((resolve) => {
      exporter.export(spans as any, resolve);
    });

    const files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);

    // Path should contain date parts: YYYY/MM/DD/HH
    const relativePath = files[0].replace(tmpDir, "");
    expect(relativePath).toMatch(/\/\d{4}\/\d{2}\/\d{2}\/\d{2}\//);

    // Filename should be UUID-based, not sequential
    const filename = relativePath.split("/").pop()!;
    expect(filename).not.toMatch(/^batch-\d+/);
    expect(filename).toEndWith(".ndjson");
  });

  it("should only export spans with mesh.tool.name attribute", async () => {
    const toolSpan = makeTestMonitoringSpan({
      [MESH_ATTR.TOOL_NAME]: "REAL_TOOL",
    });
    const httpSpan = {
      ...makeTestMonitoringSpan({}),
      attributes: { "http.method": "GET" }, // No mesh.tool.name
    };

    exporter = new NDJSONSpanExporter({
      basePath: tmpDir,
      flushThreshold: 1,
      flushIntervalMs: 60_000,
    });

    await new Promise<{ code: number }>((resolve) => {
      exporter.export([httpSpan as any], resolve);
    });

    let files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(0);

    await new Promise<{ code: number }>((resolve) => {
      exporter.export([toolSpan as any], resolve);
    });

    files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);
  });

  it("should not produce duplicate files on concurrent flushes", async () => {
    // Export multiple batches rapidly
    const exports = Array.from({ length: 5 }, (_, i) => {
      const spans = Array.from({ length: 3 }, () =>
        makeTestMonitoringSpan({ [MESH_ATTR.TOOL_NAME]: `BATCH_${i}` }),
      );
      return new Promise<{ code: number }>((resolve) => {
        exporter.export(spans as any, resolve);
      });
    });

    await Promise.all(exports);

    const files = await findNDJSONFiles(tmpDir);
    // All filenames should be unique (UUID-based)
    const filenames = files.map((f) => f.split("/").pop());
    expect(new Set(filenames).size).toBe(filenames.length);
  });

  it("should flush via forceFlush()", async () => {
    const spans = [
      makeTestMonitoringSpan({ [MESH_ATTR.TOOL_NAME]: "TOOL_FORCE" }),
    ];

    await new Promise<{ code: number }>((resolve) => {
      exporter.export(spans as any, resolve);
    });

    let files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(0);

    await exporter.forceFlush();

    files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);
  });

  it("should flush via forceFlush() when buffer is empty (no-op)", async () => {
    await exporter.forceFlush();
    const files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(0);
  });

  it("should return FAILED after shutdown", async () => {
    await exporter.shutdown();

    const result = await new Promise<{ code: number }>((resolve) => {
      exporter.export(
        [
          makeTestMonitoringSpan({
            [MESH_ATTR.TOOL_NAME]: "POST_SHUTDOWN",
          }),
        ] as any,
        resolve,
      );
    });

    expect(result.code).toBe(ExportResultCode.FAILED);
  });

  it("should return FAILED when disk write fails", async () => {
    // Use an invalid path to trigger write failure
    const badExporter = new NDJSONSpanExporter({
      basePath: "/nonexistent/readonly/path",
      flushThreshold: 1,
      flushIntervalMs: 60_000,
    });

    const result = await new Promise<{ code: number }>((resolve) => {
      badExporter.export(
        [
          makeTestMonitoringSpan({
            [MESH_ATTR.TOOL_NAME]: "FAIL_TOOL",
          }),
        ] as any,
        resolve,
      );
    });

    expect(result.code).toBe(ExportResultCode.FAILED);
  });

  it("should flush via timer interval", async () => {
    const timerExporter = new NDJSONSpanExporter({
      basePath: tmpDir,
      flushThreshold: 9999, // High so count threshold doesn't trigger
      flushIntervalMs: 50, // Short interval for test
    });

    await new Promise<{ code: number }>((resolve) => {
      timerExporter.export(
        [
          makeTestMonitoringSpan({
            [MESH_ATTR.TOOL_NAME]: "TIMER_TOOL",
          }),
        ] as any,
        resolve,
      );
    });

    // Wait for timer to fire
    await Bun.sleep(150);

    const files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);

    await timerExporter.shutdown();
  });

  it("should flush when buffer byte size exceeds maxBufferBytes", async () => {
    const smallBufferExporter = new NDJSONSpanExporter({
      basePath: tmpDir,
      flushThreshold: 9999, // High so count threshold doesn't trigger
      flushIntervalMs: 60_000,
      maxBufferBytes: 100, // Very small to trigger byte-based flush
    });

    const result = await new Promise<{ code: number }>((resolve) => {
      smallBufferExporter.export(
        [
          makeTestMonitoringSpan({
            [MESH_ATTR.TOOL_NAME]: "LARGE_TOOL",
          }),
        ] as any,
        resolve,
      );
    });

    expect(result.code).toBe(ExportResultCode.SUCCESS);

    const files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);

    await smallBufferExporter.shutdown();
  });
});
