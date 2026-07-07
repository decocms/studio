import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_MANAGER_DAEMON_CONFIG } from "../constants";
import { gitSync } from "../git/git-sync";
import { hasGitRepo, resolvePmRoot } from "../paths";
import type { Config } from "../types";
import { spawnSetupStep } from "./spawn-step";

/**
 * Per-repo package-cache env, derived from the pod-level DEPS_CACHE_ROOT
 * (the chart's node-local hostPath mount — see depsCache in
 * deploy/helm/sandbox-env/values.yaml). Keyed by the credential-stripped
 * cloneUrl so sandboxes of different repos never share cache entries.
 *
 * This key is the ONLY cross-repo isolation boundary — load-bearing, not
 * belt-and-suspenders. bun does NOT re-verify a cache entry's integrity on
 * install: tamper a cached file, reinstall, and the tampered bytes land in
 * node_modules unchecked (verified empirically). The cache dir is writable
 * by the sandbox uid, so a cache shared across repos would let one repo's
 * untrusted code overwrite a package that every other repo then installs —
 * a cross-tenant RCE. Neither copyfile nor hardlink helps; the shared
 * *writable* store is the hole. Do NOT widen this to a shared cache unless
 * it is made read-only to tenant pods and populated out-of-band by a
 * trusted process.
 *
 * Same-cloneUrl sandboxes still share a cache. For private repos that's one
 * trust domain (sandbox access implies repo write). For a repo reachable by
 * multiple orgs at different privilege levels (public/template) it is
 * cross-tenant — a known residual gap; key by org too if it matters.
 *
 * bun (install-time) reads BUN_INSTALL_CACHE_DIR; deno (dev-run-time) reads
 * DENO_DIR — see `denoCacheEnv`. npm/pnpm/yarn are unaffected by both.
 */

/**
 * 16 hex chars of sha256 over the credential-stripped cloneUrl — the per-repo
 * cache-partition key shared by every cache flavor (bun, deno, golden). Stable
 * across git-token refresh because the token lives in the URL userinfo, which
 * is stripped before hashing.
 */
function repoCacheKey(cloneUrl: string): string {
  let key = cloneUrl;
  try {
    const u = new URL(cloneUrl);
    u.username = "";
    u.password = "";
    key = u.toString();
  } catch {
    // non-URL cloneUrl (ssh shorthand) — hash it as-is
  }
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * The repo's cloneUrl for cache-key derivation. Prefer the daemon config, but
 * fall back to the cloned repo's `origin` remote: on warm-pool adopt/resurrect
 * paths the runtime config often arrives without `git.repository`, so keying
 * off the config alone silently disables every cache (DENO_DIR, bun, golden)
 * and each boot re-fetches from cold. The repo is always cloned by the time
 * any cache is consulted (install/start), so its origin remote is a reliable
 * fallback. repoCacheKey strips credentials, so the token in the remote URL
 * doesn't perturb the key.
 */
export function resolveCloneUrl(config: Config): string | undefined {
  const fromConfig = config.git?.repository?.cloneUrl;
  if (fromConfig) return fromConfig;
  const repoDir = config.repoDir;
  if (!repoDir || !hasGitRepo(repoDir)) return undefined;
  try {
    return (
      gitSync(["remote", "get-url", "origin"], { cwd: repoDir }) || undefined
    );
  } catch {
    return undefined;
  }
}

export function depsCacheEnv(
  config: Config,
  cacheRoot: string | undefined = process.env.DEPS_CACHE_ROOT,
): Record<string, string> | null {
  if (!cacheRoot) return null;
  const cloneUrl = resolveCloneUrl(config);
  if (!cloneUrl) return null;
  return {
    BUN_INSTALL_CACHE_DIR: join(cacheRoot, "bun", repoCacheKey(cloneUrl)),
  };
}

/**
 * Per-repo DENO_DIR for deno projects. Deno has no install step — it fetches
 * jsr/npm/https deps lazily into DENO_DIR at `deno task dev` time — so unlike
 * bun's cache this must be injected into the dev-server (start) env, not the
 * install env (see orchestrator.stepStart). Returns null for non-deno package
 * managers so bun/npm/pnpm/yarn dev servers are untouched.
 *
 * Kept per-repo like the bun cache. Deno DOES re-verify cached module content
 * against deno.lock integrity hashes on load — so a shared deno cache would be
 * materially less dangerous than a shared bun one (poison → error, not silent
 * RCE). But that only covers lockfile-pinned modules; a repo with no/partial
 * deno.lock has no expected hash to check, so "less dangerous" is not "safe".
 * Stay per-repo — it costs nothing and doesn't depend on every tenant keeping
 * a complete lockfile.
 */
export function denoCacheEnv(
  config: Config,
  cacheRoot: string | undefined = process.env.DEPS_CACHE_ROOT,
): Record<string, string> | null {
  if (!cacheRoot) return null;
  if (config.application?.packageManager?.name !== "deno") return null;
  const cloneUrl = resolveCloneUrl(config);
  if (!cloneUrl) return null;
  return { DENO_DIR: join(cacheRoot, "deno", repoCacheKey(cloneUrl)) };
}

export interface InstallDeps {
  config: Config;
  dropPrivileges?: boolean;
  env?: Readonly<Record<string, string>>;
  onChunk: (source: "setup", data: string) => void;
}

export function spawnInstall(deps: InstallDeps): Promise<number> | null {
  const { config } = deps;
  const pm = config.application?.packageManager?.name;
  if (!pm) return null;
  const pmConfig = PACKAGE_MANAGER_DAEMON_CONFIG[pm];
  if (!pmConfig) return null;
  // No install command (e.g. deno) — runtime fetches deps lazily on first
  // task. Caller treats null as "nothing to do" and proceeds to start.
  if (!pmConfig.install) return null;
  const installRoot = resolvePmRoot(
    config.repoDir,
    config.application?.packageManager?.path,
  );
  const hasManifest = pmConfig.manifests.some((file) =>
    existsSync(join(installRoot, file)),
  );
  if (!hasManifest) {
    deps.onChunk(
      "setup",
      `\r\n[install] no package manifest (${pmConfig.manifests.join(" or ")}) found at ${installRoot} — skipping install\r\n`,
    );
    return null;
  }
  const corepack =
    "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && (corepack enable 2>/dev/null || true) && ";
  const cmd = `${config.runtimePathPrefix}cd ${installRoot} && ${corepack}${pmConfig.install}`;
  deps.onChunk("setup", `\r\n$ ${cmd}\r\n`);
  // User-supplied config.env last: an explicit BUN_INSTALL_CACHE_DIR wins.
  const cacheEnv = depsCacheEnv(config);
  const env = cacheEnv ? { ...cacheEnv, ...deps.env } : deps.env;
  return spawnSetupStep(cmd, deps.onChunk, {
    dropPrivileges: deps.dropPrivileges,
    env,
  });
}
