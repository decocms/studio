import { describe, expect, it } from "bun:test";
import { denoCacheEnv, depsCacheEnv } from "./install";
import type { Config } from "../types";

function configWith(cloneUrl?: string, pm?: string): Config {
  return {
    git: cloneUrl ? { repository: { cloneUrl } } : undefined,
    application: pm ? { packageManager: { name: pm } } : undefined,
  } as Config;
}

describe("depsCacheEnv", () => {
  it("returns null without a cache root", () => {
    expect(depsCacheEnv(configWith("https://x.com/a/b"), undefined)).toBeNull();
  });

  it("returns null without a cloneUrl", () => {
    expect(depsCacheEnv(configWith(), "/deps-cache")).toBeNull();
  });

  it("keys the cache dir under <root>/bun/<hash>", () => {
    const env = depsCacheEnv(configWith("https://x.com/a/b"), "/deps-cache");
    expect(env?.BUN_INSTALL_CACHE_DIR).toMatch(
      /^\/deps-cache\/bun\/[0-9a-f]{16}$/,
    );
  });

  it("ignores credentials embedded in the cloneUrl", () => {
    const a = depsCacheEnv(
      configWith("https://user:tok1@x.com/a/b"),
      "/deps-cache",
    );
    const b = depsCacheEnv(
      configWith("https://user:tok2@x.com/a/b"),
      "/deps-cache",
    );
    const bare = depsCacheEnv(configWith("https://x.com/a/b"), "/deps-cache");
    expect(a).toEqual(b);
    expect(a).toEqual(bare);
  });

  it("is stable across git token refresh (github x-access-token form)", () => {
    // Mesh embeds a short-lived OAuth token in the cloneUrl userinfo
    // (github-clone-info.ts: https://x-access-token:<token>@github.com/...)
    // and rotates it via git-credential-refresh. The cache key must not
    // move when the token does, or every refresh orphans the cache.
    const url = (tok: string) =>
      `https://x-access-token:${tok}@github.com/o/n.git`;
    const a = depsCacheEnv(configWith(url("ghs_expires")), "/deps-cache");
    const b = depsCacheEnv(configWith(url("ghs_refreshed")), "/deps-cache");
    const bare = depsCacheEnv(
      configWith("https://github.com/o/n.git"),
      "/deps-cache",
    );
    expect(a).toEqual(b);
    expect(a).toEqual(bare);
  });

  it("distinct repos get distinct cache dirs", () => {
    const a = depsCacheEnv(configWith("https://x.com/a/b"), "/deps-cache");
    const b = depsCacheEnv(configWith("https://x.com/a/c"), "/deps-cache");
    expect(a?.BUN_INSTALL_CACHE_DIR).not.toBe(b?.BUN_INSTALL_CACHE_DIR);
  });

  it("hashes non-URL cloneUrls as-is", () => {
    const env = depsCacheEnv(configWith("git@x.com:a/b.git"), "/deps-cache");
    expect(env?.BUN_INSTALL_CACHE_DIR).toMatch(
      /^\/deps-cache\/bun\/[0-9a-f]{16}$/,
    );
  });
});

describe("denoCacheEnv", () => {
  it("returns null for non-deno package managers", () => {
    expect(
      denoCacheEnv(configWith("https://x.com/a/b", "bun"), "/deps-cache"),
    ).toBeNull();
    expect(
      denoCacheEnv(configWith("https://x.com/a/b"), "/deps-cache"),
    ).toBeNull();
  });

  it("returns null without a cache root or cloneUrl", () => {
    expect(
      denoCacheEnv(configWith("https://x.com/a/b", "deno"), undefined),
    ).toBeNull();
    expect(
      denoCacheEnv(configWith(undefined, "deno"), "/deps-cache"),
    ).toBeNull();
  });

  it("sets DENO_DIR under <root>/deno/<repo-hash> for deno", () => {
    const env = denoCacheEnv(
      configWith("https://x.com/a/b", "deno"),
      "/deps-cache",
    );
    expect(env?.DENO_DIR).toMatch(/^\/deps-cache\/deno\/[0-9a-f]{16}$/);
  });

  it("shares the per-repo key with the bun cache (same repo → same hash)", () => {
    const deno = denoCacheEnv(
      configWith("https://x.com/a/b", "deno"),
      "/deps-cache",
    );
    const bun = depsCacheEnv(configWith("https://x.com/a/b"), "/deps-cache");
    const denoHash = deno?.DENO_DIR?.split("/").pop();
    const bunHash = bun?.BUN_INSTALL_CACHE_DIR?.split("/").pop();
    expect(denoHash).toBe(bunHash);
  });

  it("is stable across git-token refresh (credential-stripped)", () => {
    const a = denoCacheEnv(
      configWith("https://x-access-token:t1@github.com/o/n.git", "deno"),
      "/deps-cache",
    );
    const b = denoCacheEnv(
      configWith("https://x-access-token:t2@github.com/o/n.git", "deno"),
      "/deps-cache",
    );
    expect(a?.DENO_DIR).toBe(b?.DENO_DIR);
  });
});
