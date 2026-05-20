import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFsStore } from "./local-fs-store";

describe("LocalFsStore", () => {
  let baseDir: string;
  let store: LocalFsStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "sandbox-store-"));
    store = new LocalFsStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("round-trips a Uint8Array body byte-for-byte", async () => {
    const key = "org/vmcp/main.tar";
    const payload = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 255]);
    await store.put(key, payload);

    const stream = await store.get(key);
    expect(stream).not.toBeNull();
    const got = await readAll(stream!);
    expect(Array.from(got)).toEqual(Array.from(payload));
  });

  it("round-trips a ReadableStream body byte-for-byte", async () => {
    const key = "org/vmcp/main.tar";
    const payload = Buffer.from("hello world, this is a tar payload", "utf8");
    const upload = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(payload));
        controller.close();
      },
    });
    await store.put(key, upload);

    const stream = await store.get(key);
    expect(stream).not.toBeNull();
    const got = await readAll(stream!);
    expect(Buffer.from(got).toString("utf8")).toBe(payload.toString("utf8"));
  });

  it("creates intermediate directories for nested keys", async () => {
    const key = "org/vmcp/deco/lucky-dolphin.tar";
    await store.put(key, new Uint8Array([42]));
    const head = await store.head(key);
    expect(head?.size).toBe(1);
  });

  it("get returns null for absent keys", async () => {
    expect(await store.get("missing/key.tar")).toBeNull();
  });

  it("head returns null for absent keys", async () => {
    expect(await store.head("missing/key.tar")).toBeNull();
  });

  it("head returns size and etag for present keys", async () => {
    const payload = new Uint8Array(1024);
    await store.put("org/vmcp/main.tar", payload);
    const head = await store.head("org/vmcp/main.tar");
    expect(head?.size).toBe(1024);
    expect(head?.etag).toMatch(/^mtime-/);
  });

  it("delete removes the key", async () => {
    await store.put("org/vmcp/main.tar", new Uint8Array([1]));
    expect(await store.head("org/vmcp/main.tar")).not.toBeNull();
    await store.delete("org/vmcp/main.tar");
    expect(await store.head("org/vmcp/main.tar")).toBeNull();
  });

  it("delete is idempotent (missing keys are a no-op)", async () => {
    await store.delete("never/existed.tar");
  });

  it("overwriting an existing key replaces the bytes atomically", async () => {
    await store.put("org/vmcp/main.tar", new Uint8Array([1, 1, 1]));
    await store.put("org/vmcp/main.tar", new Uint8Array([9, 9, 9, 9, 9]));
    const got = await readAll((await store.get("org/vmcp/main.tar"))!);
    expect(Array.from(got)).toEqual([9, 9, 9, 9, 9]);
  });

  it("leaves no temp files in baseDir after a successful write", async () => {
    await store.put("org/vmcp/main.tar", new Uint8Array([1, 2, 3]));
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(baseDir, "org/vmcp"));
    expect(files.filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("rejects absolute keys", async () => {
    await expect(store.put("/etc/passwd", new Uint8Array([0]))).rejects.toThrow(
      /absolute key not allowed/,
    );
  });

  it("rejects keys that escape baseDir via traversal", async () => {
    await expect(
      store.put("../../etc/passwd.tar", new Uint8Array([0])),
    ).rejects.toThrow(/escapes baseDir/);
    await expect(store.head("../../etc/passwd.tar")).rejects.toThrow(
      /escapes baseDir/,
    );
    await expect(store.get("../../etc/passwd.tar")).rejects.toThrow(
      /escapes baseDir/,
    );
    await expect(store.delete("../../etc/passwd.tar")).rejects.toThrow(
      /escapes baseDir/,
    );
  });

  it("rejects empty keys", async () => {
    await expect(store.put("", new Uint8Array([0]))).rejects.toThrow(
      /key is required/,
    );
  });

  it("constructor rejects empty baseDir", () => {
    expect(() => new LocalFsStore("")).toThrow(/baseDir is required/);
  });

  it("ignores pre-existing temp files (does not return them as snapshots)", async () => {
    // Seed a stale temp file from a previous interrupted write; head/get
    // should still report the real key as absent.
    const stalePath = join(baseDir, "org/vmcp");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stalePath, { recursive: true });
    await writeFile(
      join(stalePath, "main.tar.tmp.99999.0"),
      Buffer.from("stale"),
    );
    expect(await store.head("org/vmcp/main.tar")).toBeNull();
    expect(await store.get("org/vmcp/main.tar")).toBeNull();
  });
});

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
