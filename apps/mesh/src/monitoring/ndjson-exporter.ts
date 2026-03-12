import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface NDJSONExporterOptions<T = unknown> {
  basePath: string;
  flushThreshold?: number;
  flushIntervalMs?: number;
  maxBufferBytes?: number;
  partitionKey?: (row: T) => string;
}

export class NDJSONExporter<T> {
  private bufferItems: Array<{ partition: string; json: string }> = [];
  private bufferBytes = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushQueue: Promise<void> = Promise.resolve();
  private basePath: string;
  private flushThreshold: number;
  private maxBufferBytes: number;
  private isShutdown = false;
  private knownDirs = new Set<string>();
  private partitionKey?: (row: T) => string;

  constructor(options: NDJSONExporterOptions<T>) {
    this.basePath = options.basePath;
    this.flushThreshold = options.flushThreshold ?? 1000;
    this.maxBufferBytes = options.maxBufferBytes ?? 10 * 1024 * 1024;
    this.partitionKey = options.partitionKey;

    const intervalMs = options.flushIntervalMs ?? 60_000;
    if (intervalMs > 0 && intervalMs < 60_000 * 60) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => {
          console.error("[NDJSONExporter] Timer flush failed:", err);
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

  exportRows(rows: T[]): Promise<ExportResult> {
    if (this.isShutdown) {
      return Promise.resolve({ code: ExportResultCode.FAILED });
    }

    for (const row of rows) {
      const json = JSON.stringify(row);
      const partition = this.partitionKey ? this.partitionKey(row) : "";
      this.bufferItems.push({ partition, json });
      this.bufferBytes += Buffer.byteLength(json, "utf8") + 1;
    }

    if (
      this.bufferItems.length >= this.flushThreshold ||
      this.bufferBytes >= this.maxBufferBytes
    ) {
      return this.flush()
        .then(() => ({ code: ExportResultCode.SUCCESS }))
        .catch((err) => {
          console.error("[NDJSONExporter] Flush failed:", err);
          return { code: ExportResultCode.FAILED };
        });
    }

    return Promise.resolve({ code: ExportResultCode.SUCCESS });
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.flushQueue;
    } catch {
      /* flush() already restored buffer */
    }
    if (this.bufferItems.length > 0) {
      await this.flush();
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.flushQueue;
    } catch {
      /* flush() already restored buffer */
    }
    if (this.bufferItems.length > 0) {
      await this.flush();
    }
  }

  private flush(): Promise<void> {
    const prev = this.flushQueue;
    const next = prev.catch(() => {}).then(() => this.doFlush());
    this.flushQueue = next;
    return next;
  }

  private async doFlush(): Promise<void> {
    if (this.bufferItems.length === 0) return;

    const items = this.bufferItems;
    this.bufferItems = [];
    this.bufferBytes = 0;

    try {
      const groups = new Map<string, string[]>();
      for (const item of items) {
        let group = groups.get(item.partition);
        if (!group) {
          group = [];
          groups.set(item.partition, group);
        }
        group.push(item.json);
      }

      await Promise.all(
        Array.from(groups.entries()).map(([partition, strings]) =>
          this.writeNDJSON(strings, partition),
        ),
      );
    } catch (err) {
      // Prepend restored items, then recalculate bytes for the entire
      // merged buffer (includes rows added by concurrent exportRows calls).
      this.bufferItems = items.concat(this.bufferItems);
      this.bufferBytes = 0;
      for (const item of this.bufferItems) {
        this.bufferBytes += Buffer.byteLength(item.json, "utf8") + 1;
      }
      throw err;
    }
  }

  private async writeNDJSON(
    strings: string[],
    partition: string,
  ): Promise<void> {
    const now = new Date();
    const timeParts = [
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      String(now.getUTCHours()).padStart(2, "0"),
    ];
    const dir = partition
      ? join(this.basePath, partition, ...timeParts)
      : join(this.basePath, ...timeParts);

    if (!this.knownDirs.has(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
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
