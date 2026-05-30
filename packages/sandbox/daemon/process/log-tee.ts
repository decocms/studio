import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Append-mode tee to a single log file. Each chunk is flushed to the
 * kernel via writeSync; fsync only happens on close to keep per-chunk
 * overhead low. Hard size cap is enforced by **rotation**: when a write
 * would exceed `maxBytes`, the file is unlinked and reopened fresh with a
 * `[log rotated at N bytes]` marker. This keeps per-log disk bounded at
 * roughly `maxBytes` even for long-lived tasks that restart many times
 * (e.g. a dev script crash-looping inside a pod).
 *
 * Open the tee lazily: callers can defer creating the file until the
 * first write so empty logs don't litter the disk.
 */
export class LogTee {
  private fd: number | null = null;
  private written = 0;
  private rotatedOnce = false;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
  ) {}

  write(data: string): void {
    if (data.length === 0) return;
    const buf = Buffer.from(data, "utf-8");
    if (this.written + buf.length > this.maxBytes) {
      this.rotate();
    }
    if (!this.openIfNeeded()) return;
    try {
      writeSync(this.fd as number, buf);
      this.written += buf.length;
    } catch {
      /* swallow — log writes must never crash the daemon */
    }
  }

  private rotate(): void {
    this.close();
    try {
      unlinkSync(this.path);
    } catch {
      /* ignore — already gone or never existed */
    }
    this.written = 0;
    this.rotatedOnce = true;
    if (!this.openIfNeeded()) return;
    const marker = Buffer.from(
      `[log rotated at ${this.maxBytes} bytes]\n`,
      "utf-8",
    );
    try {
      writeSync(this.fd as number, marker);
      this.written = marker.length;
    } catch {
      /* ignore */
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
    return this.rotatedOnce;
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
