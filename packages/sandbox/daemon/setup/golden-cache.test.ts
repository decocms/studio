import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  goldenEnabled,
  goldenNodeModulesPath,
  lockfileHash,
  pruneGoldens,
  sameFilesystem,
} from "./golden-cache";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "golden-test-"));
}

describe("goldenNodeModulesPath", () => {
  const base = {
    cacheRoot: "/deps-cache",
    cloneUrl: "https://github.com/o/n.git",
    pm: "bun",
    lockHash: "abc123",
  };

  it("is null without cacheRoot / cloneUrl / lockHash", () => {
    expect(goldenNodeModulesPath({ ...base, cacheRoot: undefined })).toBeNull();
    expect(goldenNodeModulesPath({ ...base, cloneUrl: undefined })).toBeNull();
    expect(goldenNodeModulesPath({ ...base, lockHash: null })).toBeNull();
  });

  it("composes <root>/golden/<repo>/<pm>-<lockhash>/node_modules", () => {
    const p = goldenNodeModulesPath(base);
    expect(p).toMatch(
      /^\/deps-cache\/golden\/[0-9a-f]{16}\/bun-abc123\/node_modules$/,
    );
  });

  it("keys by repo — different repos get different golden dirs", () => {
    const a = goldenNodeModulesPath(base);
    const b = goldenNodeModulesPath({
      ...base,
      cloneUrl: "https://github.com/o/other.git",
    });
    expect(a).not.toBe(b);
  });

  it("is stable across git-token refresh (credential-stripped key)", () => {
    const url = (t: string) => `https://x-access-token:${t}@github.com/o/n.git`;
    const a = goldenNodeModulesPath({ ...base, cloneUrl: url("tok1") });
    const b = goldenNodeModulesPath({ ...base, cloneUrl: url("tok2") });
    const bare = goldenNodeModulesPath(base);
    expect(a).toBe(b);
    expect(a).toBe(bare);
  });

  it("separates package managers for the same lockfile hash", () => {
    const bun = goldenNodeModulesPath({ ...base, pm: "bun" });
    const pnpm = goldenNodeModulesPath({ ...base, pm: "pnpm" });
    expect(bun).not.toBe(pnpm);
  });
});

describe("lockfileHash", () => {
  it("returns null when no lockfile is present", async () => {
    expect(await lockfileHash(await tmp(), "bun")).toBeNull();
  });

  it("returns null for a package manager with no known lockfile", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "bun.lock"), "x");
    expect(await lockfileHash(dir, "deno")).toBeNull();
  });

  it("hashes lockfile content — same bytes, same hash; different bytes differ", async () => {
    const a = await tmp();
    const b = await tmp();
    const c = await tmp();
    await writeFile(join(a, "bun.lock"), "lockfile-A");
    await writeFile(join(b, "bun.lock"), "lockfile-A");
    await writeFile(join(c, "bun.lock"), "lockfile-B");
    const ha = await lockfileHash(a, "bun");
    expect(ha).toBeTruthy();
    expect(await lockfileHash(b, "bun")).toBe(ha);
    expect(await lockfileHash(c, "bun")).not.toBe(ha);
  });

  it("picks the pm's lockfile (npm uses package-lock.json)", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "package-lock.json"), "{}");
    expect(await lockfileHash(dir, "npm")).toBeTruthy();
    // bun ignores an npm lockfile
    expect(await lockfileHash(dir, "bun")).toBeNull();
  });
});

describe("goldenEnabled (kill switch)", () => {
  const orig = process.env.GOLDEN_CACHE_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.GOLDEN_CACHE_ENABLED;
    else process.env.GOLDEN_CACHE_ENABLED = orig;
  });

  it("is off by default (unset)", () => {
    delete process.env.GOLDEN_CACHE_ENABLED;
    expect(goldenEnabled()).toBe(false);
  });

  it('is on for "1" and "true" only', () => {
    process.env.GOLDEN_CACHE_ENABLED = "1";
    expect(goldenEnabled()).toBe(true);
    process.env.GOLDEN_CACHE_ENABLED = "true";
    expect(goldenEnabled()).toBe(true);
  });

  it("stays off for other values", () => {
    for (const v of ["0", "false", "yes", "", "on"]) {
      process.env.GOLDEN_CACHE_ENABLED = v;
      expect(goldenEnabled()).toBe(false);
    }
  });
});

describe("sameFilesystem", () => {
  it("true for a path against itself", async () => {
    const dir = await tmp();
    expect(await sameFilesystem(dir, dir)).toBe(true);
  });

  it("false when a path does not exist", async () => {
    expect(await sameFilesystem("/nonexistent/xyz", await tmp())).toBe(false);
  });
});

describe("pruneGoldens", () => {
  // Make a golden dir <root>/golden/<repo>/<name> with a given mtime (ms).
  async function mkGolden(
    root: string,
    repo: string,
    name: string,
    mtimeMs: number,
  ): Promise<string> {
    const dir = join(root, "golden", repo, name);
    await mkdir(dir, { recursive: true });
    const t = new Date(mtimeMs);
    await utimes(dir, t, t);
    return dir;
  }

  it("no-ops on a missing cache root / empty store", async () => {
    await expect(pruneGoldens(undefined)).resolves.toBeUndefined();
    await expect(pruneGoldens(await tmp())).resolves.toBeUndefined();
  });

  it("drops goldens older than the TTL, keeps fresh ones", async () => {
    const root = await tmp();
    const now = 1_000_000_000_000;
    const fresh = await mkGolden(root, "repoA", "bun-fresh", now - 1000);
    const stale = await mkGolden(
      root,
      "repoA",
      "bun-stale",
      now - 10 * 86_400_000,
    );
    await pruneGoldens(root, { now, ttlMs: 7 * 86_400_000, maxPerRepo: 99 });
    expect(await exists(fresh)).toBe(true);
    expect(await exists(stale)).toBe(false);
  });

  it("caps to the newest maxPerRepo per repo", async () => {
    const root = await tmp();
    const now = 1_000_000_000_000;
    const dirs = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        mkGolden(root, "repoB", `bun-${i}`, now - i * 1000),
      ),
    );
    await pruneGoldens(root, { now, ttlMs: 999 * 86_400_000, maxPerRepo: 2 });
    // Newest two (i=0,1) survive; older two (i=2,3) are pruned.
    expect(await exists(dirs[0])).toBe(true);
    expect(await exists(dirs[1])).toBe(true);
    expect(await exists(dirs[2])).toBe(false);
    expect(await exists(dirs[3])).toBe(false);
  });

  it("never reaps in-flight .tmp. publishes", async () => {
    const root = await tmp();
    const now = 1_000_000_000_000;
    const tmpPublish = await mkGolden(
      root,
      "repoC",
      ".tmp.123.node_modules",
      now - 999 * 86_400_000, // ancient, but must be skipped
    );
    await pruneGoldens(root, { now, ttlMs: 1, maxPerRepo: 0 });
    expect(await exists(tmpPublish)).toBe(true);
  });

  it("prunes each repo independently", async () => {
    const root = await tmp();
    const now = 1_000_000_000_000;
    const a = await mkGolden(root, "repoA", "bun-1", now);
    const b = await mkGolden(root, "repoB", "bun-1", now);
    await pruneGoldens(root, { now, ttlMs: 999 * 86_400_000, maxPerRepo: 5 });
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(true);
  });
});
