import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface NDJSONExporterOptions {
  basePath: string;
  flushThreshold?: number;
  flushIntervalMs?: number;
  maxBufferBytes?: number;
}

export class NDJSONExporter<T> {
  private bufferStrings: string[] = [];
  private bufferBytes = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushQueue: Promise<void> = Promise.resolve();
  private basePath: string;
  private flushThreshold: number;
  private maxBufferBytes: number;
  private isShutdown = false;
  private knownDirs = new Set<string>();

  constructor(options: NDJSONExporterOptions) {
    this.basePath = options.basePath;
    this.flushThreshold = options.flushThreshold ?? 1000;
    this.maxBufferBytes = options.maxBufferBytes ?? 10 * 1024 * 1024;

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
      this.bufferStrings.push(json);
      this.bufferBytes += Buffer.byteLength(json, "utf8") + 1;
    }

    if (
      this.bufferStrings.length >= this.flushThreshold ||
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
    if (this.bufferStrings.length > 0) {
      await this.flush();
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.flushQueue;
    } catch {
      /* flush() already restored buffer */
    }
    if (this.bufferStrings.length > 0) {
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
    if (this.bufferStrings.length === 0) return;

    const strings = this.bufferStrings;
    this.bufferStrings = [];
    this.bufferBytes = 0;

    try {
      await this.writeNDJSON(strings);
    } catch (err) {
      // Prepend restored strings, then recalculate bytes for the entire
      // merged buffer (includes rows added by concurrent exportRows calls).
      this.bufferStrings = strings.concat(this.bufferStrings);
      this.bufferBytes = 0;
      for (const s of this.bufferStrings) {
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
