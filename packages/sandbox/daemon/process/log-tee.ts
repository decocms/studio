import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Append-mode tee to a single log file. Each chunk is flushed to the
 * kernel via writeSync; fsync only happens on close to keep per-chunk
 * overhead low. Hard size cap protects against runaway output — once we
 * exceed `maxBytes`, subsequent writes are dropped (with a single
 * truncation marker emitted) until the tee is closed.
 *
 * Open the tee lazily: callers can defer creating the file until the
 * first write so empty logs don't litter the disk.
 */
export class LogTee {
  private fd: number | null = null;
  private written = 0;
  private truncated = false;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
  ) {}

  write(data: string): void {
    if (data.length === 0) return;
    if (this.truncated) return;
    const buf = Buffer.from(data, "utf-8");
    if (this.written + buf.length > this.maxBytes) {
      this.truncated = true;
      const remain = Math.max(0, this.maxBytes - this.written);
      if (remain > 0 && this.openIfNeeded()) {
        try {
          writeSync(this.fd as number, buf, 0, remain);
          this.written += remain;
        } catch {
          /* unrecoverable; leave truncated as-is */
        }
      }
      const marker = Buffer.from(
        `\n[log truncated at ${this.maxBytes} bytes]\n`,
        "utf-8",
      );
      if (this.openIfNeeded()) {
        try {
          writeSync(this.fd as number, marker);
        } catch {
          /* ignore */
        }
      }
      this.close();
      return;
    }
    if (!this.openIfNeeded()) return;
    try {
      writeSync(this.fd as number, buf);
      this.written += buf.length;
    } catch {
      /* swallow — log writes must never crash the daemon */
    }
  }

  writeHeader(label: string): void {
    let prior = this.written;
    if (this.fd === null) {
      try {
        prior = statSync(this.path).size;
      } catch {
        /* new file */
      }
    }
    this.write(
      prior > 0
        ? `\r\n=== ${new Date().toISOString()} ${label} ===\r\n`
        : `${label}\r\n`,
    );
  }

  isTruncated(): boolean {
    return this.truncated;
  }

  bytesWritten(): number {
    return this.written;
  }

  close(): void {
    if (this.fd === null) return;
    try {
      fsyncSync(this.fd);
    } catch {
      /* fsync best-effort */
    }
    try {
      closeSync(this.fd);
    } catch {
      /* ignore */
    }
    this.fd = null;
  }

  private openIfNeeded(): boolean {
    if (this.fd !== null) return true;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      // Seed from existing file size so the cap applies across runs that
      // append to the same path (named-script tees rerun without clearing).
      try {
        this.written = statSync(this.path).size;
      } catch {
        /* file doesn't exist yet */
      }
      this.fd = openSync(this.path, "a", 0o600);
      return true;
    } catch {
      return false;
    }
  }
}
