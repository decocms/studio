// Unit-tier per TESTING.md: no mocks, no DB, no network — hermetic filesystem
// use in a fresh per-test mkdtemp dir only.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decofileCacheEnabled,
  decofileCacheStats,
  getBlob,
  getMerged,
  makeScratchDir,
  putBlob,
  putMerged,
  removeScratchDir,
  resetDecofileDiskCacheForTests,
  sweepDecofileCacheForTests,
} from "./disk-cache";

const ENV_KEYS = [
  "DECOFILE_CACHE_DIR",
  "DECOFILE_CACHE_MAX_BYTES",
  "DECOFILE_CACHE_MERGED_MAX_BYTES",
  "DECOFILE_CACHE_MAX_BLOB_BYTES",
  "DECOFILE_CACHE_MAX_MERGED_BYTES",
  "DECOFILE_CACHE_FREE_FLOOR_BYTES",
  "DECOFILE_CACHE_SWEEP_INTERVAL_MS",
] as const;

function sha(seed: string): string {
  return seed.repeat(40).slice(0, 40);
}

async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const info = await stat(path);
    if (info.isDirectory()) out.push(...(await walkFiles(path, rel)));
    else out.push(rel);
  }
  return out;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "decofile-disk-cache-test-"));
  for (const key of ENV_KEYS) delete Bun.env[key];
  Bun.env.DECOFILE_CACHE_DIR = root;
  // The default 1 GiB floor could legitimately trip on a full dev machine;
  // tests that don't exercise the floor disable it.
  Bun.env.DECOFILE_CACHE_FREE_FLOOR_BYTES = "0";
  resetDecofileDiskCacheForTests();
});

afterEach(async () => {
  resetDecofileDiskCacheForTests();
  for (const key of ENV_KEYS) delete Bun.env[key];
  await rm(root, { recursive: true, force: true });
});

describe("disk-cache", () => {
  it("round-trips blobs and merged docs", async () => {
    await putBlob("Acme", "Site", sha("a"), "blob-content");
    await putMerged("Acme", "Site", sha("b"), `{"merged":true}`);

    expect(await getBlob("Acme", "Site", sha("a"))).toBe("blob-content");
    expect(await getMerged("Acme", "Site", sha("b"))).toBe(`{"merged":true}`);

    // Sanitized (lowercased) layout on disk, merged suffixed .json.
    const files = await walkFiles(root);
    expect(files).toContain(`blobs/acme/site/${sha("a")}`);
    expect(files).toContain(`merged/acme/site/${sha("b")}.json`);

    const stats = decofileCacheStats();
    expect(stats.hits.blobs).toBe(1);
    expect(stats.hits.merged).toBe(1);
    expect(stats.totalBytes).toBe(
      "blob-content".length + `{"merged":true}`.length,
    );
  });

  it("misses on unknown keys", async () => {
    expect(await getBlob("acme", "site", sha("f"))).toBeNull();
    expect(decofileCacheStats().misses.blobs).toBe(1);
  });

  it("is fully disabled when DECOFILE_CACHE_DIR is empty", async () => {
    Bun.env.DECOFILE_CACHE_DIR = "";
    resetDecofileDiskCacheForTests();

    expect(decofileCacheEnabled()).toBe(false);
    await putBlob("acme", "site", sha("a"), "content");
    expect(await getBlob("acme", "site", sha("a"))).toBeNull();
    expect(await makeScratchDir()).toBeNull();
  });

  it("refuses admission for oversized entries", async () => {
    Bun.env.DECOFILE_CACHE_MAX_BLOB_BYTES = "4";
    resetDecofileDiskCacheForTests();

    await putBlob("acme", "site", sha("a"), "way-too-large");
    expect(await getBlob("acme", "site", sha("a"))).toBeNull();
    expect(await walkFiles(join(root, "blobs"))).toEqual([]);
    expect(decofileCacheStats().admissionRefusals).toBe(1);
  });

  it("evicts oldest entries and deletes their files", async () => {
    Bun.env.DECOFILE_CACHE_MAX_BYTES = "100";
    Bun.env.DECOFILE_CACHE_MERGED_MAX_BYTES = "100";
    resetDecofileDiskCacheForTests();

    const sixty = "x".repeat(60);
    await putBlob("acme", "site", sha("a"), sixty);
    await putBlob("acme", "site", sha("b"), sixty); // 120 > 100 → evict a

    expect(await getBlob("acme", "site", sha("a"))).toBeNull();
    expect(await getBlob("acme", "site", sha("b"))).toBe(sixty);
    const files = await walkFiles(join(root, "blobs"));
    expect(files).toEqual([`acme/site/${sha("b")}`]);
    expect(decofileCacheStats().evictions).toBe(1);
    expect(decofileCacheStats().totalBytes).toBe(60);
  });

  it("leaves no partial files outside tmp/ (atomic writes)", async () => {
    await putBlob("acme", "site", sha("a"), "one");
    await putMerged("acme", "site", sha("b"), "two");

    const files = await walkFiles(root);
    expect(files.sort()).toEqual([
      `blobs/acme/site/${sha("a")}`,
      `merged/acme/site/${sha("b")}.json`,
    ]);
    // No staging leftovers.
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("skips writes for invalid shas and empty segments without throwing", async () => {
    await putBlob("acme", "site", "not-a-sha", "content");
    await putBlob("acme", "site", sha("a").toUpperCase(), "content");
    await putBlob("", "site", sha("a"), "content");
    await putMerged("acme", "", sha("a"), "content");

    expect(await walkFiles(join(root, "blobs"))).toEqual([]);
    expect(await walkFiles(join(root, "merged"))).toEqual([]);
    expect(decofileCacheStats().invalidKeySkips).toBe(4);

    expect(await getBlob("acme", "site", "not-a-sha")).toBeNull();
    expect(await getMerged("", "site", sha("a"))).toBeNull();
  });

  it("re-initializes from an existing dir (restart-warm)", async () => {
    await putBlob("acme", "site", sha("a"), "persisted");
    await putMerged("acme", "site", sha("b"), "merged-doc");

    // Same dir, fresh module state — simulates a process restart.
    resetDecofileDiskCacheForTests();

    expect(await getBlob("acme", "site", sha("a"))).toBe("persisted");
    expect(await getMerged("acme", "site", sha("b"))).toBe("merged-doc");
    const stats = decofileCacheStats();
    expect(stats.entryCount).toBe(2);
    expect(stats.totalBytes).toBe("persisted".length + "merged-doc".length);
  });

  it("skips writes when free space is under the floor", async () => {
    // Absurdly high floor: no volume has this much free space.
    Bun.env.DECOFILE_CACHE_FREE_FLOOR_BYTES = "999999999999999999";
    resetDecofileDiskCacheForTests();

    await putBlob("acme", "site", sha("a"), "content");
    expect(await getBlob("acme", "site", sha("a"))).toBeNull();
    expect(decofileCacheStats().floorSkips).toBe(1);
  });

  it("creates and removes scratch dirs under tmp/", async () => {
    const dir = await makeScratchDir();
    expect(dir).not.toBeNull();
    expect(dir?.startsWith(join(root, "tmp"))).toBe(true);
    expect((await readdir(join(root, "tmp"))).length).toBe(1);

    await removeScratchDir(dir as string);
    expect(await readdir(join(root, "tmp"))).toEqual([]);
    // Removing a nonexistent dir is a no-op, not a throw.
    await removeScratchDir(join(root, "tmp", "never-existed"));
  });

  it("sweep reconciles externally deleted files and prunes old tmp dirs", async () => {
    await putBlob("acme", "site", sha("a"), "aaaa");
    await putBlob("acme", "site", sha("b"), "bbbb");

    // Delete one file behind the cache's back.
    await unlink(join(root, "blobs", "acme", "site", sha("a")));

    // One stale tmp dir (2h old) and one fresh scratch dir.
    const stale = join(root, "tmp", "stale-op");
    await mkdir(stale, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(stale, old, old);
    const fresh = await makeScratchDir();

    await sweepDecofileCacheForTests();

    const stats = decofileCacheStats();
    expect(stats.entryCount).toBe(1);
    expect(stats.totalBytes).toBe(4);
    const tmpEntries = await readdir(join(root, "tmp"));
    expect(tmpEntries).not.toContain("stale-op");
    expect(fresh && tmpEntries.length === 1).toBe(true);
  });
});
