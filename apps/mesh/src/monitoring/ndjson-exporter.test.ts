import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { NDJSONExporter } from "./ndjson-exporter";
import { ExportResultCode } from "@opentelemetry/core";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNDJSONFiles } from "./test-utils";

interface TestRow {
  v: 1;
  id: string;
  value: string;
}

function makeTestExporter(
  basePath: string,
  opts?: {
    flushThreshold?: number;
    flushIntervalMs?: number;
    maxBufferBytes?: number;
  },
) {
  return new NDJSONExporter<TestRow>({
    basePath,
    flushThreshold: opts?.flushThreshold ?? 3,
    flushIntervalMs: opts?.flushIntervalMs ?? 60_000,
    maxBufferBytes: opts?.maxBufferBytes,
  });
}

describe("NDJSONExporter", () => {
  let tmpDir: string;
  let exporter: NDJSONExporter<TestRow>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ndjson-exporter-test-"));
    exporter = makeTestExporter(tmpDir);
  });

  afterEach(async () => {
    await exporter.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should buffer rows and flush when threshold reached", async () => {
    const rows: TestRow[] = [
      { v: 1, id: "1", value: "a" },
      { v: 1, id: "2", value: "b" },
      { v: 1, id: "3", value: "c" },
    ];
    const result = await exporter.exportRows(rows);
    expect(result.code).toBe(ExportResultCode.SUCCESS);

    const files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);

    const content = await readFile(files[0]!, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]!)).toEqual({ v: 1, id: "1", value: "a" });
  });

  it("should flush remaining buffer on shutdown", async () => {
    await exporter.exportRows([{ v: 1, id: "1", value: "a" }]);

    let files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(0); // below threshold

    await exporter.shutdown();

    files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);
  });

  it("should return FAILED after shutdown", async () => {
    await exporter.shutdown();
    const result = await exporter.exportRows([{ v: 1, id: "1", value: "a" }]);
    expect(result.code).toBe(ExportResultCode.FAILED);
  });

  it("should flush via forceFlush()", async () => {
    await exporter.exportRows([{ v: 1, id: "1", value: "a" }]);

    let files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(0);

    await exporter.forceFlush();

    files = await findNDJSONFiles(tmpDir);
    expect(files.length).toBe(1);
  });
});
