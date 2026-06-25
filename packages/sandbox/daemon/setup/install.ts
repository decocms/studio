import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_MANAGER_DAEMON_CONFIG } from "../constants";
import { resolvePmRoot } from "../paths";
import type { Config } from "../types";
import { spawnSetupStep } from "./spawn-step";

/**
 * Substitutes {owner} and {repo} placeholders in a path template using the
 * clone URL. Handles authenticated URLs (x-access-token:...@github.com) and
 * plain ones. Returns null if the template needs placeholders but the URL
 * doesn't match.
 */
function resolveCachePathFromTemplate(
  template: string,
  cloneUrl: string | undefined,
): string | null {
  if (!template.includes("{")) return template;
  if (!cloneUrl) return null;
  const match = cloneUrl.match(
    /github\.com\/([^/@]+)\/([^/.]+?)(?:\.git)?(?:[?#]|$)/,
  );
  if (!match) return null;
  const [, owner, repo] = match;
  return template.replace("{owner}", owner).replace("{repo}", repo);
}

/**
 * For Deno projects, tries to pre-populate $DENO_DIR from any S3-compatible
 * storage so the first `deno task dev` skips remote import fetching.
 *
 * Required env vars:
 *   DECO_CACHE_S3_ACCESS_KEY_ID
 *   DECO_CACHE_S3_SECRET_ACCESS_KEY
 *   DECO_CACHE_S3_REGION
 *   DECO_CACHE_S3_BUCKET
 *
 * Optional env vars:
 *   DECO_CACHE_S3_ENDPOINT      — S3-compatible endpoint (e.g. MinIO, R2, GCS)
 *                                 defaults to AWS S3 virtual-hosted URL
 *   DECO_CACHE_S3_PATH_TEMPLATE — object key template with {owner} and {repo}
 *                                 placeholders, e.g. "{owner}/{repo}/cache.tar.zst"
 *   DECO_CACHE_S3_PATH          — full explicit object key, overrides
 *                                 DECO_CACHE_S3_PATH_TEMPLATE entirely
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
    !process.env.DECO_CACHE_S3_ACCESS_KEY_ID ||
    !process.env.DECO_CACHE_S3_SECRET_ACCESS_KEY
  )
    return null;

  const region = process.env.DECO_CACHE_S3_REGION;
  const bucket = process.env.DECO_CACHE_S3_BUCKET;
  if (!region || !bucket) return null;

  // Explicit path takes precedence; otherwise expand the template.
  let cachePath = process.env.DECO_CACHE_S3_PATH;
  if (!cachePath) {
    const template = process.env.DECO_CACHE_S3_PATH_TEMPLATE;
    if (!template) return null;
    cachePath = resolveCachePathFromTemplate(
      template,
      config.git?.repository?.cloneUrl,
    );
    if (!cachePath) return null;
  }

  const endpoint = process.env.DECO_CACHE_S3_ENDPOINT;
  const baseUrl = endpoint
    ? `${endpoint}/${bucket}`
    : `https://${bucket}.s3.${region}.amazonaws.com`;

  // Credentials are referenced as shell variables so they never appear in
  // the command string or in process listings.
  const cmd = [
    `DECO_CACHE_TMP=$(mktemp)`,
    `DECO_CACHE_DIR=\${DENO_DIR:-$HOME/.deno}`,
    `mkdir -p "$DECO_CACHE_DIR"`,
    `if curl -sf --aws-sigv4 "aws:amz:${region}:s3" \\`,
    `    --user "$DECO_CACHE_S3_ACCESS_KEY_ID:$DECO_CACHE_S3_SECRET_ACCESS_KEY" \\`,
    `    "${baseUrl}/${cachePath}" -o "$DECO_CACHE_TMP"; then`,
    `  zstd -d "$DECO_CACHE_TMP" --stdout | tar xf - -C "$DECO_CACHE_DIR" --no-same-permissions --no-same-owner`,
    `  echo "[deno cache] restored from s3 (${cachePath})"`,
    `else`,
    `  echo "[deno cache] not available (${cachePath}) — deno will fetch deps on first run"`,
    `fi`,
    `rm -f "$DECO_CACHE_TMP"`,
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
