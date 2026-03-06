import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { ParquetSpanExporter } from "./parquet-span-exporter";
import {
  MONITORING_SPAN_ATTRIBUTES,
  MONITORING_SPAN_NAME,
} from "./parquet-schema";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a mock ReadableSpan with monitoring attributes */
function createMonitoringSpan(
  overrides: Partial<{
    organizationId: string;
    connectionId: string;
    connectionTitle: string;
    toolName: string;
    input: string;
    output: string;
    isError: boolean;
    errorMessage: string | null;
    durationMs: number;
    userId: string | null;
    requestId: string;
    userAgent: string | null;
    virtualMcpId: string | null;
    properties: string | null;
  }> = {},
): ReadableSpan {
  const attrs: Record<string, unknown> = {
    [MONITORING_SPAN_ATTRIBUTES.ORGANIZATION_ID]:
      overrides.organizationId ?? "org_1",
    [MONITORING_SPAN_ATTRIBUTES.CONNECTION_ID]:
      overrides.connectionId ?? "conn_1",
    [MONITORING_SPAN_ATTRIBUTES.CONNECTION_TITLE]:
      overrides.connectionTitle ?? "Test Connection",
    [MONITORING_SPAN_ATTRIBUTES.TOOL_NAME]: overrides.toolName ?? "test_tool",
    [MONITORING_SPAN_ATTRIBUTES.INPUT]: overrides.input ?? '{"key":"value"}',
    [MONITORING_SPAN_ATTRIBUTES.OUTPUT]: overrides.output ?? '{"result":"ok"}',
    [MONITORING_SPAN_ATTRIBUTES.IS_ERROR]: overrides.isError ?? false,
    [MONITORING_SPAN_ATTRIBUTES.ERROR_MESSAGE]: overrides.errorMessage ?? null,
    [MONITORING_SPAN_ATTRIBUTES.DURATION_MS]: overrides.durationMs ?? 150,
    [MONITORING_SPAN_ATTRIBUTES.USER_ID]: overrides.userId ?? "user_1",
    [MONITORING_SPAN_ATTRIBUTES.REQUEST_ID]: overrides.requestId ?? "req_1",
    [MONITORING_SPAN_ATTRIBUTES.USER_AGENT]:
      overrides.userAgent ?? "test-client/1.0",
    [MONITORING_SPAN_ATTRIBUTES.VIRTUAL_MCP_ID]: overrides.virtualMcpId ?? null,
    [MONITORING_SPAN_ATTRIBUTES.PROPERTIES]: overrides.properties ?? null,
  };

  return {
    name: MONITORING_SPAN_NAME,
    attributes: attrs,
    spanContext: () => ({
      traceId: crypto.randomUUID().replace(/-/g, ""),
      spanId: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      traceFlags: 1,
    }),
    startTime: [Math.floor(Date.now() / 1000), 0],
    endTime: [Math.floor(Date.now() / 1000) + 1, 0],
    kind: 0,
    status: { code: 0 },
    resource: { attributes: {} },
    instrumentationLibrary: { name: "test" },
    events: [],
    links: [],
    duration: [0, 150_000_000], // 150ms in [seconds, nanoseconds]
    ended: true,
    parentSpanId: undefined,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

/** Create a non-monitoring span (should be ignored by exporter) */
function createRegularSpan(): ReadableSpan {
  return {
    name: "http.request",
    attributes: { "http.method": "GET" },
    spanContext: () => ({
      traceId: "abc",
      spanId: "def",
      traceFlags: 1,
    }),
    startTime: [Math.floor(Date.now() / 1000), 0],
    endTime: [Math.floor(Date.now() / 1000) + 1, 0],
    kind: 0,
    status: { code: 0 },
    resource: { attributes: {} },
    instrumentationLibrary: { name: "test" },
    events: [],
    links: [],
    duration: [0, 100_000_000],
    ended: true,
    parentSpanId: undefined,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

describe("ParquetSpanExporter", () => {
  let basePath: string;
  let exporter: ParquetSpanExporter;

  beforeEach(async () => {
    basePath = await mkdtemp(join(tmpdir(), "parquet-test-"));
    exporter = new ParquetSpanExporter({
      basePath,
      flushThreshold: 3, // Low threshold for testing
      flushIntervalMs: 60_000, // Long interval so we control flushes manually
    });
  });

  afterEach(async () => {
    await exporter.shutdown();
    await rm(basePath, { recursive: true, force: true });
  });

  it("ignores non-monitoring spans", async () => {
    const result = await exportSpans(exporter, [createRegularSpan()]);
    expect(result).toBe(ExportResultCode.SUCCESS);
    // Force flush — should produce no files since no monitoring spans buffered
    await exporter.forceFlush();
    const files = await findParquetFiles(basePath);
    expect(files.length).toBe(0);
  });

  it("buffers monitoring spans and flushes at threshold", async () => {
    const spans = [
      createMonitoringSpan({ toolName: "tool_a", requestId: "r1" }),
      createMonitoringSpan({ toolName: "tool_b", requestId: "r2" }),
      createMonitoringSpan({ toolName: "tool_c", requestId: "r3" }),
    ];
    const result = await exportSpans(exporter, spans);
    expect(result).toBe(ExportResultCode.SUCCESS);

    // Wait a tick for async flush
    await new Promise((r) => setTimeout(r, 200));

    const files = await findParquetFiles(basePath);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.parquet$/);
  });

  it("forceFlush writes buffered spans even below threshold", async () => {
    await exportSpans(exporter, [
      createMonitoringSpan({ toolName: "single_tool", requestId: "r1" }),
    ]);

    // Below threshold of 3, but forceFlush should still write
    await exporter.forceFlush();

    const files = await findParquetFiles(basePath);
    expect(files.length).toBe(1);
  });

  it("does not write empty buffer on forceFlush", async () => {
    await exporter.forceFlush();
    const files = await findParquetFiles(basePath);
    expect(files.length).toBe(0);
  });

  it("handles error spans correctly", async () => {
    await exportSpans(exporter, [
      createMonitoringSpan({
        isError: true,
        errorMessage: "Connection timeout",
        requestId: "r_err",
      }),
    ]);
    await exporter.forceFlush();

    const files = await findParquetFiles(basePath);
    expect(files.length).toBe(1);
  });

  it("creates time-partitioned directory structure", async () => {
    await exportSpans(exporter, [createMonitoringSpan({ requestId: "r_dir" })]);
    await exporter.forceFlush();

    const files = await findParquetFiles(basePath);
    expect(files.length).toBe(1);

    // Should follow YYYY/MM/DD/HH pattern
    const relativePath = files[0]!.replace(basePath + "/", "");
    const parts = relativePath.split("/");
    // parts: [YYYY, MM, DD, HH, batch-NNNNNN.parquet]
    expect(parts.length).toBe(5);
    expect(parts[0]).toMatch(/^\d{4}$/); // year
    expect(parts[1]).toMatch(/^\d{2}$/); // month
    expect(parts[2]).toMatch(/^\d{2}$/); // day
    expect(parts[3]).toMatch(/^\d{2}$/); // hour
    expect(parts[4]).toMatch(/^batch-\d{6}\.parquet$/);
  });
});

/** Helper: export spans and return result code */
function exportSpans(
  exporter: ParquetSpanExporter,
  spans: ReadableSpan[],
): Promise<ExportResultCode> {
  return new Promise((resolve) => {
    exporter.export(spans, (result) => {
      resolve(result.code);
    });
  });
}

/** Helper: recursively find all .parquet files under a directory */
async function findParquetFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, {
      withFileTypes: true,
      recursive: true,
    });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".parquet")) {
        // biome-ignore lint: Dirent parentPath varies by Node version
        const parent = (entry as any).parentPath as string | undefined;
        const entryPath = parent
          ? join(parent, entry.name)
          : join(dir, entry.name);
        results.push(entryPath);
      }
    }
  } catch {
    // Directory might not exist yet
  }
  return results;
}
