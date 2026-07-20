import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it, test } from "bun:test";
import {
  denoCacheEnv,
  depsCacheEnv,
  installSteps,
  resolveCloneUrl,
} from "./install";
import type { Config } from "../types";

function configWith(cloneUrl?: string, pm?: string): Config {
  return {
    git: cloneUrl ? { repository: { cloneUrl } } : undefined,
    application: pm ? { packageManager: { name: pm } } : undefined,
  } as Config;
}

/** A real on-disk git repo with an `origin` remote, for the fallback path. */
function repoWithOrigin(originUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "deps-cache-test-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: dir });
  run(["init", "-q"]);
  run(["remote", "add", "origin", originUrl]);
  return dir;
}

describe("resolveCloneUrl", () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it("prefers the cloneUrl in the config", () => {
    expect(resolveCloneUrl(configWith("https://x.com/a/b"))).toBe(
      "https://x.com/a/b",
    );
  });

  it("falls back to the cloned repo's origin remote when config has none", () => {
    // Regression: on warm-pool adopt/resurrect the runtime config arrives
    // without git.repository, so keying off config alone leaves DENO_DIR unset
    // and every boot re-fetches cold.
    const dir = repoWithOrigin("https://github.com/o/n.git");
    tmpDirs.push(dir);
    const config = { repoDir: dir } as Config;
    expect(resolveCloneUrl(config)).toBe("https://github.com/o/n.git");
    // and the cache env now keys off it instead of returning null
    expect(depsCacheEnv(config, "/deps-cache")?.BUN_INSTALL_CACHE_DIR).toMatch(
      /^\/deps-cache\/bun\/[0-9a-f]{16}$/,
    );
  });

  it("fallback key matches the same repo passed via config (token-stripped)", () => {
    const dir = repoWithOrigin("https://x-access-token:tok@github.com/o/n.git");
    tmpDirs.push(dir);
    const viaRemote = depsCacheEnv({ repoDir: dir } as Config, "/deps-cache");
    const viaConfig = depsCacheEnv(
      configWith("https://github.com/o/n.git"),
      "/deps-cache",
    );
    expect(viaRemote).toEqual(viaConfig);
  });

  it("returns undefined with neither config cloneUrl nor a git repo", () => {
    expect(resolveCloneUrl({} as Config)).toBeUndefined();
    const empty = mkdtempSync(join(tmpdir(), "deps-cache-test-"));
    tmpDirs.push(empty);
    expect(resolveCloneUrl({ repoDir: empty } as Config)).toBeUndefined();
  });
});

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
    // Studio embeds a short-lived OAuth token in the cloneUrl userinfo
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

describe("installSteps", () => {
  test("bun repo → corepack(best-effort) then bun install with cwd + env", () => {
    const steps = installSteps({
      pm: "bun",
      installRoot: "/repo/apps/site",
      runtimePathDirs: ["/opt/bun/bin"],
      cacheEnv: { BUN_INSTALL_CACHE_DIR: "/cache/bun/abc" },
      userEnv: { FOO: "1" },
      basePath: "/usr/bin",
    });
    expect(steps?.corepack.argv).toEqual(["corepack", "enable"]);
    expect(steps?.install.argv).toEqual(["bun", "install"]);
    expect(steps?.install.cwd).toBe("/repo/apps/site");
    expect(steps?.install.env).toMatchObject({
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      BUN_INSTALL_CACHE_DIR: "/cache/bun/abc",
      FOO: "1",
    });
    expect(steps?.install.env?.PATH?.startsWith("/opt/bun/bin")).toBe(true);
  });

  test("no user PATH → runtime dirs prepended to basePath, never replacing it", () => {
    const steps = installSteps({
      pm: "bun",
      installRoot: "/repo/apps/site",
      runtimePathDirs: ["/opt/bun/bin"],
      cacheEnv: null,
      userEnv: { FOO: "1" },
      basePath: "/usr/bin",
    });
    // The prepend must fall back to the base PATH when the user env carries
    // none — a bare PATH of only the runtime dirs would strip coreutils/git
    // from every spawned step.
    expect(steps?.install.env?.PATH).toBe(`/opt/bun/bin${delimiter}/usr/bin`);
    expect(steps?.install.env?.PATH?.endsWith("/usr/bin")).toBe(true);
  });

  test("user-supplied PATH is prepended-to, not replaced", () => {
    const steps = installSteps({
      pm: "bun",
      installRoot: "/repo/apps/site",
      runtimePathDirs: ["/opt/bun/bin"],
      cacheEnv: null,
      userEnv: { PATH: "/custom/bin" },
      basePath: "/usr/bin",
    });
    // Runtime PATH dirs win the PATH key specifically, prepended onto the
    // user's PATH override rather than the whole PATH getting replaced by
    // it — every other user env key still wins outright.
    expect(steps?.install.env?.PATH).toBe(
      `/opt/bun/bin${delimiter}/custom/bin`,
    );
  });

  test("deno → null (no install step)", () => {
    expect(
      installSteps({
        pm: "deno",
        installRoot: "/r",
        runtimePathDirs: [],
        cacheEnv: null,
        userEnv: undefined,
        basePath: "/usr/bin",
      }),
    ).toBeNull();
  });
});
