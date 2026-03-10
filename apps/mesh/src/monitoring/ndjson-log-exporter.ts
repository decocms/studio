/**
 * NDJSONLogExporter
 *
 * Custom OpenTelemetry LogRecordExporter that writes monitoring log records
 * to time-partitioned NDJSON files on local disk.
 *
 * Used in local mode (npx decocms). In cloud mode, the standard
 * OTLPLogExporter sends logs to an OTel Collector sidecar instead.
 *
 * Flow:
 * 1. OTel SDK calls export(logs) after each batch
 * 2. We filter for log records with mesh.monitoring.type === "tool_call"
 * 3. Records are buffered in memory
 * 4. When buffer reaches flushThreshold (default 1000), maxBufferBytes
 *    (default 10MB), or flushIntervalMs (default 60s), we write an NDJSON file
 * 5. File path: {basePath}/YYYY/MM/DD/HH/{uuid}.ndjson
 *
 * NDJSON format: one JSON object per line. ClickHouse (chdb) reads this
 * natively via file('*.ndjson', JSONEachRow).
 *
 * Note: Directory partitioning uses flush time (not record time), so a record
 * from 23:59 flushed at 00:01 lands in the next hour's partition. This is
 * benign because chdb queries use glob patterns spanning all partitions.
 *
 * Zero external dependencies beyond the OTel SDK and Node/Bun fs APIs.
 */

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MONITORING_LOG_ATTR,
  MONITORING_LOG_TYPE_VALUE,
  logRecordToMonitoringRow,
} from "./schema";

export interface NDJSONLogExporterOptions {
  /** Base directory for NDJSON files. Default: ./data/monitoring */
  basePath: string;
  /** Flush after this many records. Default: 1000 */
  flushThreshold?: number;
  /** Flush after this many ms. Default: 60000 (1 minute) */
  flushIntervalMs?: number;
  /** Flush when buffer byte size exceeds this. Default: 10MB */
  maxBufferBytes?: number;
}

export class NDJSONLogExporter implements LogRecordExporter {
  private bufferStrings: string[] = [];
  private bufferBytes = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushQueue: Promise<void> = Promise.resolve();
  private basePath: string;
  private flushThreshold: number;
  private maxBufferBytes: number;
  private isShutdown = false;
  /** Cache of directories known to exist, avoiding redundant mkdir syscalls. */
  private knownDirs = new Set<string>();

  constructor(options: NDJSONLogExporterOptions) {
    this.basePath = options.basePath;
    this.flushThreshold = options.flushThreshold ?? 1000;
    this.maxBufferBytes = options.maxBufferBytes ?? 10 * 1024 * 1024; // 10MB

    const intervalMs = options.flushIntervalMs ?? 60_000;
    if (intervalMs > 0 && intervalMs < 60_000 * 60) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => {
          console.error("[NDJSONLogExporter] Timer flush failed:", err);
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
    logRecords: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.isShutdown) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    for (const record of logRecords) {
      // Filter: only monitoring log records
      if (
        record.attributes[MONITORING_LOG_ATTR.TYPE] !==
        MONITORING_LOG_TYPE_VALUE
      ) {
        continue;
      }

      const attrs: Record<string, string | number | boolean | undefined> = {};
      for (const [key, value] of Object.entries(record.attributes)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          attrs[key] = value;
        }
      }

      const id = record.spanContext?.spanId ?? crypto.randomUUID();

      const hrTime = record.hrTime;
      const timestampNano =
        BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1]);

      const row = logRecordToMonitoringRow({
        id,
        timestampNano,
        attributes: attrs,
      });

      const json = JSON.stringify(row);
      this.bufferStrings.push(json);
      this.bufferBytes += Buffer.byteLength(json, "utf8") + 1;
    }

    if (
      this.bufferStrings.length >= this.flushThreshold ||
      this.bufferBytes >= this.maxBufferBytes
    ) {
      this.flush()
        .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
        .catch((err) => {
          console.error("[NDJSONLogExporter] Flush failed:", err);
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
    // Wait for any in-flight flush, then flush remaining records
    try {
      await this.flushQueue;
    } catch {
      // Ignore — flush() already restored the buffer on failure
    }
    if (this.bufferStrings.length > 0) {
      await this.flush();
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.flushQueue;
    } catch {
      // Ignore — flush() already restored the buffer on failure
    }
    if (this.bufferStrings.length > 0) {
      await this.flush();
    }
  }

  /**
   * Serialized flush: each call queues behind the previous one,
   * preventing concurrent buffer swaps (TOCTOU race).
   */
  private flush(): Promise<void> {
    const prev = this.flushQueue;
    const next = prev
      .catch(() => {
        /* ignore previous failure */
      })
      .then(() => this.doFlush());
    this.flushQueue = next;
    return next;
  }

  private async doFlush(): Promise<void> {
    if (this.bufferStrings.length === 0) return;

    const strings = this.bufferStrings;
    this.bufferStrings = [];
    this.bufferBytes = 0;

    try {
      await this.writeNDJSON(strings);
    } catch (err) {
      // Restore buffer so records are not lost on write failure
      this.bufferStrings = strings.concat(this.bufferStrings);
      for (const s of strings) {
        this.bufferBytes += Buffer.byteLength(s, "utf8") + 1;
      }
      throw err;
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
