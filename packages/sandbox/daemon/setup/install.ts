import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_MANAGER_DAEMON_CONFIG } from "../constants";
import { resolvePmRoot } from "../paths";
import type { Config } from "../types";
import { spawnSetupStep } from "./spawn-step";

function parseGithubRepoName(cloneUrl: string): string | null {
  // Handles authenticated URLs (x-access-token:...@github.com) and plain ones.
  const match = cloneUrl.match(
    /github\.com\/[^/@]+\/([^/.]+?)(?:\.git)?(?:[?#]|$)/,
  );
  return match ? match[1] : null;
}

/**
 * For Deno projects, tries to pre-populate $DENO_DIR from any S3-compatible
 * storage so the first `deno task dev` skips remote import fetching.
 *
 * Required env vars:
 *   DENO_CACHE_S3_ACCESS_KEY_ID
 *   DENO_CACHE_S3_SECRET_ACCESS_KEY
 *   DENO_CACHE_S3_REGION
 *   DENO_CACHE_S3_BUCKET
 *
 * Optional env vars:
 *   DENO_CACHE_S3_ENDPOINT    — S3-compatible endpoint (e.g. MinIO, R2, GCS)
 *                               defaults to AWS S3 virtual-hosted URL
 *   DENO_CACHE_S3_PATH_PREFIX — path prefix prepended to the repo name,
 *                               e.g. "my-org/caches" →
 *                               "my-org/caches/<repo>/cache.tar.zst"
 *   DENO_CACHE_S3_PATH_FILE   — cache filename, defaults to "cache.tar.zst"
 *   DENO_CACHE_S3_PATH        — full explicit object key, overrides prefix
 *                               and file derivation entirely
 *
 * Non-fatal: any failure (missing creds, object not found, network error)
 * is logged and the sandbox continues to start normally.
 */
export function tryWarmDenoCache(deps: InstallDeps): Promise<number> | null {
  const { config } = deps;
  if (config.application?.packageManager?.name !== "deno") return null;

  // Only attempt if S3 credentials are present — avoids spawning a shell
  // and showing misleading output when the env vars aren't configured.
  if (
    !process.env.DENO_CACHE_S3_ACCESS_KEY_ID ||
    !process.env.DENO_CACHE_S3_SECRET_ACCESS_KEY
  )
    return null;

  const region = process.env.DENO_CACHE_S3_REGION;
  const bucket = process.env.DENO_CACHE_S3_BUCKET;
  if (!region || !bucket) return null;

  // Resolve the object path: explicit override takes precedence; otherwise
  // build from prefix + repo name + file.
  let cachePath = process.env.DENO_CACHE_S3_PATH;
  if (!cachePath) {
    const cloneUrl = config.git?.repository?.cloneUrl;
    if (!cloneUrl) return null;
    const repoName = parseGithubRepoName(cloneUrl);
    if (!repoName) return null;
    const prefix = process.env.DENO_CACHE_S3_PATH_PREFIX ?? "";
    const file = process.env.DENO_CACHE_S3_PATH_FILE ?? "cache.tar.zst";
    cachePath = prefix ? `${prefix}/${repoName}/${file}` : `${repoName}/${file}`;
  }

  const endpoint = process.env.DENO_CACHE_S3_ENDPOINT;
  const baseUrl = endpoint
    ? `${endpoint}/${bucket}`
    : `https://${bucket}.s3.${region}.amazonaws.com`;

  // Credentials are referenced as shell variables so they never appear in
  // the command string or in process listings.
  const cmd = [
    `DENO_CACHE_TMP=$(mktemp)`,
    `DENO_CACHE_DIR=\${DENO_DIR:-$HOME/.deno}`,
    `mkdir -p "$DENO_CACHE_DIR"`,
    `if curl -sf --aws-sigv4 "aws:amz:${region}:s3" \\`,
    `    --user "$DENO_CACHE_S3_ACCESS_KEY_ID:$DENO_CACHE_S3_SECRET_ACCESS_KEY" \\`,
    `    "${baseUrl}/${cachePath}" -o "$DENO_CACHE_TMP"; then`,
    `  zstd -d "$DENO_CACHE_TMP" --stdout | tar xf - -C "$DENO_CACHE_DIR" --no-same-permissions --no-same-owner`,
    `  echo "[deno cache] restored from s3 (${cachePath})"`,
    `else`,
    `  echo "[deno cache] not available (${cachePath}) — deno will fetch deps on first run"`,
    `fi`,
    `rm -f "$DENO_CACHE_TMP"`,
  ].join("\n");

  deps.onChunk(
    "setup",
    `\r\n[deno cache] fetching from s3 (${cachePath})...\r\n`,
  );
  return spawnSetupStep(cmd, deps.onChunk, {
    dropPrivileges: deps.dropPrivileges,
    env: deps.env,
  });
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
  return spawnSetupStep(cmd, deps.onChunk, {
    dropPrivileges: deps.dropPrivileges,
    env: deps.env,
  });
}
