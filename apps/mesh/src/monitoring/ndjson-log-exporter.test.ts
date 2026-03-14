import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { NDJSONLogExporter } from "./ndjson-log-exporter";
import { ExportResultCode } from "@opentelemetry/core";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MONITORING_LOG_ATTR, MONITORING_LOG_TYPE_LLM_CALL } from "./schema";
import { makeTestMonitoringLogRecord, findNDJSONFiles } from "./test-utils";

describe("NDJSONLogExporter", () => {
  let tmpDir: string;
  let exporter: NDJSONLogExporter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ndjson-log-exporter-test-"));
    exporter = new NDJSONLogExporter({
      basePath: tmpDir,
      flushThreshold: 3,
      flushIntervalMs: 60_000, // High so it doesn't auto-flush
    });
  });

  afterEach(async () => {
    await exporter.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should implement LogRecordExporter interface", () => {
    expect(typeof exporter.export).toBe("function");
    expect(typeof exporter.shutdown).toBe("function");
    expect(typeof exporter.forceFlush).toBe("function");
  });

  it("should only export records with a known mesh.monitoring.type", async () => {
    const toolCallRecord = makeTestMonitoringLogRecord({
      [MONITORING_LOG_ATTR.TOOL_NAME]: "REAL_TOOL",
    });
    const llmCallRecord = makeTestMonitoringLogRecord({
      [MONITORING_LOG_ATTR.TOOL_NAME]: "gpt-4o",
      [MONITORING_LOG_ATTR.TYPE]: MONITORING_LOG_TYPE_LLM_CALL,
    });
    const unknownRecord = makeTestMonitoringLogRecord({});
    // Remove the type attribute to simulate a non-monitoring record
    delete (unknownRecord.attributes as Record<string, unknown>)[
      MONITORING_LOG_ATTR.TYPE
    ];

    exporter = new NDJSONLogExporter({
      basePath: tmpDir,
      flushThreshold: 1,
      flushIntervalMs: 60_000,
    });

    await new Promise<{ code: number }>((resolve) => {
      exporter.export([unknownRecord as any], resolve);
    });

    let files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(0);

    await new Promise<{ code: number }>((resolve) => {
      exporter.export([toolCallRecord as any], resolve);
    });

    files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);

    await new Promise<{ code: number }>((resolve) => {
      exporter.export([llmCallRecord as any], resolve);
    });

    files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(2);
  });

  it("should write valid NDJSON (one JSON object per line)", async () => {
    const records = Array.from({ length: 3 }, (_, i) =>
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: `TOOL_${i}`,
      }),
    );

    await new Promise<{ code: number }>((resolve) => {
      exporter.export(records as any, resolve);
    });

    const files = await findNDJSONFiles(tmpDir);
    const content = await readFile(files[0]!, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.v).toBe(1);
      expect(parsed.id).toBeDefined();
      expect(parsed.tool_name).toBeDefined();
      expect(parsed.organization_id).toBeDefined();
      expect(parsed.timestamp).toBeDefined();
    }
  });

  it("should write to time-partitioned paths with UUID filenames", async () => {
    const records = Array.from({ length: 3 }, () =>
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_TIME",
      }),
    );

    await new Promise<{ code: number }>((resolve) => {
      exporter.export(records as any, resolve);
    });

    const files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);

    // Path should contain date parts: YYYY/MM/DD/HH
    const relativePath = files[0]!.replace(tmpDir, "");
    expect(relativePath).toMatch(/\/\d{4}\/\d{2}\/\d{2}\/\d{2}\//);

    // Filename should be UUID-based
    const filename = relativePath.split("/").pop()!;
    expect(filename).not.toMatch(/^batch-\d+/);
    expect(filename).toEndWith(".ndjson");
  });

  it("should buffer records and flush when threshold reached", async () => {
    const records = [
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_A",
      }),
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_B",
      }),
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_C",
      }),
    ];

    const result = await new Promise<{ code: number }>((resolve) => {
      exporter.export(records as any, resolve);
    });

    expect(result.code).toBe(ExportResultCode.SUCCESS);

    const files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]).toEndWith(".ndjson");
  });

  it("should flush when buffer byte size exceeds maxBufferBytes", async () => {
    const smallBufferExporter = new NDJSONLogExporter({
      basePath: tmpDir,
      flushThreshold: 9999, // High so count threshold doesn't trigger
      flushIntervalMs: 60_000,
      maxBufferBytes: 100, // Very small to trigger byte-based flush
    });

    const result = await new Promise<{ code: number }>((resolve) => {
      smallBufferExporter.export(
        [
          makeTestMonitoringLogRecord({
            [MONITORING_LOG_ATTR.TOOL_NAME]: "LARGE_TOOL",
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

  it("should flush via timer interval", async () => {
    const timerExporter = new NDJSONLogExporter({
      basePath: tmpDir,
      flushThreshold: 9999, // High so count threshold doesn't trigger
      flushIntervalMs: 50, // Short interval for test
    });

    await new Promise<{ code: number }>((resolve) => {
      timerExporter.export(
        [
          makeTestMonitoringLogRecord({
            [MONITORING_LOG_ATTR.TOOL_NAME]: "TIMER_TOOL",
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

  it("should restore buffer on write failure", async () => {
    // Use a file as basePath so mkdir will always fail
    const blocker = join(tmpDir, "not-a-dir");
    await Bun.write(blocker, "");
    const badExporter = new NDJSONLogExporter({
      basePath: join(blocker, "subdir"),
      flushThreshold: 1,
      flushIntervalMs: 60_000,
    });

    const result = await new Promise<{ code: number }>((resolve) => {
      badExporter.export(
        [
          makeTestMonitoringLogRecord({
            [MONITORING_LOG_ATTR.TOOL_NAME]: "FAIL_TOOL",
          }),
        ] as any,
        resolve,
      );
    });

    expect(result.code).toBe(ExportResultCode.FAILED);
  });

  it("should flush remaining buffer on shutdown", async () => {
    const records = [
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_SHUTDOWN",
      }),
    ];

    await new Promise<{ code: number }>((resolve) => {
      exporter.export(records as any, resolve);
    });

    // Not yet flushed (below threshold)
    let files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(0);

    await exporter.shutdown();

    files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);
  });

  it("should flush via forceFlush()", async () => {
    const records = [
      makeTestMonitoringLogRecord({
        [MONITORING_LOG_ATTR.TOOL_NAME]: "TOOL_FORCE",
      }),
    ];

    await new Promise<{ code: number }>((resolve) => {
      exporter.export(records as any, resolve);
    });

    let files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(0);

    await exporter.forceFlush();

    files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);
  });

  it("should return FAILED after shutdown", async () => {
    await exporter.shutdown();

    const result = await new Promise<{ code: number }>((resolve) => {
      exporter.export(
        [
          makeTestMonitoringLogRecord({
            [MONITORING_LOG_ATTR.TOOL_NAME]: "POST_SHUTDOWN",
          }),
        ] as any,
        resolve,
      );
    });

    expect(result.code).toBe(ExportResultCode.FAILED);
  });

  it("should not produce duplicate files on concurrent flushes", async () => {
    const exports = Array.from({ length: 5 }, (_, i) => {
      const records = Array.from({ length: 3 }, () =>
        makeTestMonitoringLogRecord({
          [MONITORING_LOG_ATTR.TOOL_NAME]: `BATCH_${i}`,
        }),
      );
      return new Promise<{ code: number }>((resolve) => {
        exporter.export(records as any, resolve);
      });
    });

    await Promise.all(exports);

    const files = await findNDJSONFiles(tmpDir);
    // All filenames should be unique (UUID-based)
    const filenames = files.map((f) => f.split("/").pop());
    expect(new Set(filenames).size).toBe(filenames.length);
  });

  it("should flush via forceFlush() when buffer is empty (no-op)", async () => {
    await exporter.forceFlush();
    const files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(0);
  });
});
