import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  goldenNodeModulesPath,
  lockfileHash,
  sameFilesystem,
} from "./golden-cache";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "golden-test-"));
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
  it("returns null when no lockfile is present", () => {
    expect(lockfileHash(tmp(), "bun")).toBeNull();
  });

  it("returns null for a package manager with no known lockfile", () => {
    const dir = tmp();
    writeFileSync(join(dir, "bun.lock"), "x");
    expect(lockfileHash(dir, "deno")).toBeNull();
  });

  it("hashes lockfile content — same bytes, same hash; different bytes differ", () => {
    const a = tmp();
    const b = tmp();
    const c = tmp();
    writeFileSync(join(a, "bun.lock"), "lockfile-A");
    writeFileSync(join(b, "bun.lock"), "lockfile-A");
    writeFileSync(join(c, "bun.lock"), "lockfile-B");
    const ha = lockfileHash(a, "bun");
    expect(ha).toBeTruthy();
    expect(lockfileHash(b, "bun")).toBe(ha);
    expect(lockfileHash(c, "bun")).not.toBe(ha);
  });

  it("picks the pm's lockfile (npm uses package-lock.json)", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(lockfileHash(dir, "npm")).toBeTruthy();
    // bun ignores an npm lockfile
    expect(lockfileHash(dir, "bun")).toBeNull();
  });
});

describe("sameFilesystem", () => {
  it("true for a path against itself", () => {
    const dir = tmp();
    expect(sameFilesystem(dir, dir)).toBe(true);
  });

  it("false when a path does not exist", () => {
    expect(sameFilesystem("/nonexistent/xyz", tmp())).toBe(false);
  });
});
