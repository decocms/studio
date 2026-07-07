import { describe, expect, it } from "bun:test";
import { depsCacheEnv } from "./install";
import type { Config } from "../types";

function configWith(cloneUrl?: string): Config {
  return {
    git: cloneUrl ? { repository: { cloneUrl } } : undefined,
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
