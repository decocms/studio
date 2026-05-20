/**
 * LocalFsStore — SandboxStore backed by the local filesystem.
 *
 * Used in `bun run dev` and any deploy without `SANDBOX_SNAPSHOTS_BUCKET`.
 * Snapshots land under `<baseDir>/<key>` where `key` already encodes
 * `<orgId>/<vmcpId>/<branch>.tar`. Writes are atomic (temp file + rename)
 * so a half-finished save never replaces a good prior snapshot.
 *
 * Path safety: even though `snapshotKey()` in `./types.ts` sanitizes
 * components, we recheck `path.relative(baseDir, resolved)` on every call
 * as defense in depth — if any future caller bypasses the key helper, the
 * store still refuses to read or write outside its own directory.
 */

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import type { SandboxStore, SnapshotHead } from "./types";

export class LocalFsStore implements SandboxStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    if (!baseDir) {
      throw new Error("LocalFsStore: baseDir is required");
    }
    this.baseDir = resolve(baseDir);
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<void> {
    const target = this.resolveSafe(key);
    await mkdir(dirname(target), { recursive: true });

    // Atomic write: stream into a sibling temp file, then rename. Rename on
    // the same filesystem is atomic, so a reader either sees the old bytes
    // or the complete new bytes — never a half-written tar.
    const tempPath = `${target}.tmp.${randomUUID()}`;
    try {
      const ws = createWriteStream(tempPath);
      if (body instanceof Uint8Array) {
        await new Promise<void>((res, rej) => {
          ws.on("error", rej);
          ws.end(body, () => res());
        });
      } else {
        const nodeStream = Readable.fromWeb(
          body as unknown as NodeWebReadableStream<Uint8Array>,
        );
        await pipeline(nodeStream, ws);
      }
      await rename(tempPath, target);
    } catch (err) {
      // Best-effort cleanup so we don't leak temp files on failure.
      try {
        await unlink(tempPath);
      } catch {
        /* file may not exist yet */
      }
      throw err;
    }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const target = this.resolveSafe(key);
    try {
      await stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const rs = createReadStream(target);
    return Readable.toWeb(rs) as unknown as ReadableStream<Uint8Array>;
  }

  async head(key: string): Promise<SnapshotHead | null> {
    const target = this.resolveSafe(key);
    try {
      const st = await stat(target);
      // mtime as etag — sufficient for "did the bytes change?" semantics
      // within a single host. S3Store will return the real S3 ETag.
      return { size: st.size, etag: `mtime-${st.mtimeMs.toString(16)}` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveSafe(key);
    try {
      await unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  /**
   * Resolve `key` under `baseDir` and assert the result stays inside it.
   * Throws on any traversal attempt — paired with the sanitizer in
   * `snapshotKey()` for a belt-and-suspenders defense.
   */
  private resolveSafe(key: string): string {
    if (!key) throw new Error("LocalFsStore: key is required");
    if (isAbsolute(key)) {
      throw new Error(`LocalFsStore: absolute key not allowed: ${key}`);
    }
    const joined = resolve(join(this.baseDir, key));
    const rel = relative(this.baseDir, joined);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`LocalFsStore: key escapes baseDir: ${key}`);
    }
    return joined;
  }
}
