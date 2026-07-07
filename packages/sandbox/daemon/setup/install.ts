import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_MANAGER_DAEMON_CONFIG } from "../constants";
import { resolvePmRoot } from "../paths";
import type { Config } from "../types";
import { spawnSetupStep } from "./spawn-step";

/**
 * Per-repo package-cache env, derived from the pod-level DEPS_CACHE_ROOT
 * (the chart's node-local hostPath mount — see depsCache in
 * deploy/helm/sandbox-env/values.yaml). Keyed by the credential-stripped
 * cloneUrl so sandboxes of different repos never share cache entries: a
 * cache shared across repos would let one repo's untrusted code poison
 * another repo's store. Sandboxes of the *same* cloneUrl still share it,
 * which is intended for private repos (sandbox access implies repo
 * write) but is cross-tenant for repos reachable at different privilege
 * levels (public/template). Tampered cache entries are caught by bun's
 * lockfile integrity check on install, not by this key.
 *
 * Only bun consumes BUN_INSTALL_CACHE_DIR; npm/pnpm/yarn/deno ignore it.
 */
export function depsCacheEnv(
  config: Config,
  cacheRoot: string | undefined = process.env.DEPS_CACHE_ROOT,
): Record<string, string> | null {
  if (!cacheRoot) return null;
  const cloneUrl = config.git?.repository?.cloneUrl;
  if (!cloneUrl) return null;
  let key = cloneUrl;
  try {
    const u = new URL(cloneUrl);
    u.username = "";
    u.password = "";
    key = u.toString();
  } catch {
    // non-URL cloneUrl (ssh shorthand) — hash it as-is
  }
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return { BUN_INSTALL_CACHE_DIR: join(cacheRoot, "bun", hash) };
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
