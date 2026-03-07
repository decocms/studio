/**
 * NDJSONSpanExporter
 *
 * Custom OpenTelemetry SpanExporter that writes monitoring spans to
 * time-partitioned NDJSON files on local disk.
 *
 * Used in local mode (npx decocms). In cloud mode, the standard
 * OTLPTraceExporter sends spans to an OTel Collector sidecar instead.
 *
 * Flow:
 * 1. OTel SDK calls export(spans) after each batch
 * 2. We filter for spans with "mesh.tool.name" attribute (monitoring spans)
 * 3. Spans are buffered in memory
 * 4. When buffer reaches flushThreshold (default 1000), maxBufferBytes
 *    (default 10MB), or flushIntervalMs (default 60s), we write an NDJSON file
 * 5. File path: {basePath}/YYYY/MM/DD/HH/{uuid}.ndjson
 *
 * NDJSON format: one JSON object per line. ClickHouse (chdb) reads this
 * natively via file('*.ndjson', JSONEachRow).
 *
 * Note: Directory partitioning uses flush time (not span time), so a span
 * from 23:59 flushed at 00:01 lands in the next hour's partition. This is
 * benign because chdb queries use glob patterns spanning all partitions.
 *
 * Zero external dependencies beyond the OTel SDK and Node/Bun fs APIs.
 */

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { MESH_ATTR, spanToMonitoringRow } from "./schema";

export interface NDJSONSpanExporterOptions {
  /** Base directory for NDJSON files. Default: ./data/monitoring */
  basePath: string;
  /** Flush after this many spans. Default: 1000 */
  flushThreshold?: number;
  /** Flush after this many ms. Default: 60000 (1 minute) */
  flushIntervalMs?: number;
  /** Flush when buffer byte size exceeds this. Default: 10MB */
  maxBufferBytes?: number;
}

export class NDJSONSpanExporter implements SpanExporter {
  private bufferStrings: string[] = [];
  private bufferBytes = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushInProgress: Promise<void> | null = null;
  private basePath: string;
  private flushThreshold: number;
  private maxBufferBytes: number;
  private isShutdown = false;
  /** Cache of directories known to exist, avoiding redundant mkdir syscalls. */
  private knownDirs = new Set<string>();

  constructor(options: NDJSONSpanExporterOptions) {
    this.basePath = options.basePath;
    this.flushThreshold = options.flushThreshold ?? 1000;
    this.maxBufferBytes = options.maxBufferBytes ?? 10 * 1024 * 1024; // 10MB

    const intervalMs = options.flushIntervalMs ?? 60_000;
    if (intervalMs > 0 && intervalMs < 60_000 * 60) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => {
          console.error("[NDJSONSpanExporter] Timer flush failed:", err);
        });
      }, intervalMs);
      if (
        this.flushTimer &&
        typeof this.flushTimer === "object" &&
        "unref" in this.flushTimer
      ) {
        this.flushTimer.unref();
      }
    }
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.isShutdown) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    for (const span of spans) {
      const toolName = span.attributes[MESH_ATTR.TOOL_NAME];
      if (!toolName) continue;

      const attrs: Record<string, string | number | boolean | undefined> = {};
      for (const [key, value] of Object.entries(span.attributes)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          attrs[key] = value;
        }
      }

      const row = spanToMonitoringRow({
        spanId: span.spanContext().spanId,
        startTimeUnixNano:
          BigInt(span.startTime[0]) * 1_000_000_000n +
          BigInt(span.startTime[1]),
        attributes: attrs,
      });

      const json = JSON.stringify(row);
      this.bufferStrings.push(json);
      this.bufferBytes += json.length + 1;
    }

    if (
      this.bufferStrings.length >= this.flushThreshold ||
      this.bufferBytes >= this.maxBufferBytes
    ) {
      this.flush()
        .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
        .catch((err) => {
          console.error("[NDJSONSpanExporter] Flush failed:", err);
          resultCallback({ code: ExportResultCode.FAILED });
        });
    } else {
      resultCallback({ code: ExportResultCode.SUCCESS });
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.bufferStrings.length > 0) {
      await this.flush();
    }
  }

  async forceFlush(): Promise<void> {
    if (this.bufferStrings.length > 0) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.flushInProgress) {
      await this.flushInProgress;
    }

    if (this.bufferStrings.length === 0) return;

    const strings = this.bufferStrings;
    this.bufferStrings = [];
    this.bufferBytes = 0;

    this.flushInProgress = this.writeNDJSON(strings);
    try {
      await this.flushInProgress;
    } catch (err) {
      // Restore buffer so spans are not lost on write failure
      this.bufferStrings = strings.concat(this.bufferStrings);
      for (const s of strings) {
        this.bufferBytes += s.length + 1;
      }
      throw err;
    } finally {
      this.flushInProgress = null;
    }
  }

  private async writeNDJSON(strings: string[]): Promise<void> {
    const now = new Date();
    const dir = join(
      this.basePath,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      String(now.getUTCHours()).padStart(2, "0"),
    );

    if (!this.knownDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      this.knownDirs.add(dir);
    }

    const filename = `${crypto.randomUUID()}.ndjson`;
    const tmpPath = join(dir, `.${filename}.tmp`);
    const finalPath = join(dir, filename);

    const content = strings.join("\n") + "\n";

    await writeFile(tmpPath, content, { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }
}
