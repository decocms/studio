import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_MANAGER_DAEMON_CONFIG } from "../constants";
import { resolvePmRoot } from "../paths";
import type { Config } from "../types";
import { spawnSetupStep } from "./spawn-step";

function parseGithubOwnerRepo(
  cloneUrl: string,
): { owner: string; repo: string } | null {
  // Handles authenticated URLs (x-access-token:...@github.com) and plain ones.
  const match = cloneUrl.match(
    /github\.com\/([^/@]+)\/([^/.]+?)(?:\.git)?(?:[?#]|$)/,
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * For deco site repos (Deno), tries to pre-populate $DENO_DIR from S3 so
 * the first `deno task dev` doesn't need to re-fetch all remote imports.
 *
 * Requires DENO_DECO_CACHE_S3_ACCESS_KEY_ID + DENO_DECO_CACHE_S3_SECRET_ACCESS_KEY
 * in the pod environment. Non-fatal: any failure (missing creds, S3 object
 * not found, network error) is logged and the sandbox continues normally.
 */
export function trySpawnDecoSiteCache(deps: InstallDeps): Promise<number> | null {
  const { config } = deps;
  if (config.application?.packageManager?.name !== "deno") return null;

  // Only attempt if S3 credentials are present — avoids spawning a shell
  // and showing misleading output when the env vars aren't configured.
  if (
    !process.env.DENO_DECO_CACHE_S3_ACCESS_KEY_ID ||
    !process.env.DENO_DECO_CACHE_S3_SECRET_ACCESS_KEY
  )
    return null;

  const cloneUrl = config.git?.repository?.cloneUrl;
  if (!cloneUrl) return null;
  const ownerRepo = parseGithubOwnerRepo(cloneUrl);
  if (!ownerRepo) return null;

  const { owner, repo } = ownerRepo;
  const region = process.env.DENO_DECO_CACHE_S3_REGION;
  const bucket = process.env.DENO_DECO_CACHE_S3_BUCKET;
  if (!region || !bucket) return null;
  const endpoint = process.env.DENO_DECO_CACHE_S3_ENDPOINT;
  const baseUrl = endpoint
    ? `${endpoint}/${bucket}`
    : `https://${bucket}.s3.${region}.amazonaws.com`;

  // Credentials are referenced as shell variables so they never appear in
  // the command string or in process listings.
  const cmd = [
    `DECO_CACHE_TMP=$(mktemp)`,
    `DECO_DIR=\${DENO_DIR:-$HOME/.deno}`,
    `mkdir -p "$DECO_DIR"`,
    `if curl -sf --aws-sigv4 "aws:amz:${region}:s3" \\`,
    `    --user "$DENO_DECO_CACHE_S3_ACCESS_KEY_ID:$DENO_DECO_CACHE_S3_SECRET_ACCESS_KEY" \\`,
    `    "${baseUrl}/${owner}/${repo}/cache.tar.zst" -o "$DECO_CACHE_TMP"; then`,
    `  zstd -d "$DECO_CACHE_TMP" --stdout | tar xf - -C "$DECO_DIR" --no-same-permissions --no-same-owner`,
    `  echo "[deco-site cache] deno deps restored from s3 (${owner}/${repo})"`,
    `else`,
    `  echo "[deco-site cache] s3 cache not available (${owner}/${repo}) — deno will fetch deps on first run"`,
    `fi`,
    `rm -f "$DECO_CACHE_TMP"`,
  ].join("\n");

  deps.onChunk(
    "setup",
    `\r\n[deco-site cache] fetching deno deps from s3 (${owner}/${repo})...\r\n`,
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
