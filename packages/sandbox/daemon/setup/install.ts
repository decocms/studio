import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PACKAGE_MANAGER_DAEMON_CONFIG } from "../constants";
import { resolvePmRoot } from "../paths";
import type { Config } from "../types";
import { spawnSetupStep } from "./spawn-step";

function resolveDecoCachePath(config: Config): string | null {
  const { owner, name } = config.git?.repository ?? {};
  if (!owner || owner !== "deco-sites" || !name) return null;
  return `${owner}/${name}/cache.tar.zst`;
}

/**
 * For Deno projects, tries to pre-populate $DENO_DIR from S3 so the first
 * `deno task dev` skips remote import fetching.
 *
 * Credentials are provided via Pod Identity (EKS) or the standard AWS
 * credential chain — no static keys needed in env vars.
 *
 * Required env vars:
 *   DECO_CACHE_S3_REGION
 *   DECO_CACHE_S3_BUCKET
 *
 * Optional env vars:
 *   DECO_CACHE_S3_ENDPOINT — S3-compatible endpoint (e.g. MinIO, R2)
 *
 * Non-fatal: any failure (object not found, network error, auth error)
 * is logged and the sandbox continues to start normally.
 */
export function tryWarmDenoCache(deps: InstallDeps): Promise<void> | null {
  const { config } = deps;
  if (config.application?.packageManager?.name !== "deno") return null;

  const region = process.env.DECO_CACHE_S3_REGION;
  const bucket = process.env.DECO_CACHE_S3_BUCKET;
  if (!region || !bucket) return null;

  const cachePath = resolveDecoCachePath(config);
  if (!cachePath) return null;

  return (async () => {
    deps.onChunk(
      "setup",
      `\r\n[deno cache] fetching from s3 (${cachePath})...\r\n`,
    );

    const endpoint = process.env.DECO_CACHE_S3_ENDPOINT;
    const s3 = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });

    let tmpDir: string | null = null;
    try {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: cachePath }),
      );
      if (!res.Body) throw new Error("empty response body");

      tmpDir = await mkdtemp(join(tmpdir(), "deco-cache-"));
      const tmpFile = join(tmpDir, "cache.tar.zst");
      await pipeline(
        res.Body as NodeJS.ReadableStream,
        createWriteStream(tmpFile),
      );

      const denoDir =
        deps.env?.DENO_DIR ?? process.env.DENO_DIR ?? join(homedir(), ".deno");
      const cmd = [
        `mkdir -p "${denoDir}"`,
        `zstd -d "${tmpFile}" --stdout | tar xf - -C "${denoDir}" --no-same-permissions --no-same-owner`,
        `echo "[deno cache] restored from s3 (${cachePath})"`,
      ].join(" && ");

      await spawnSetupStep(cmd, deps.onChunk, {
        dropPrivileges: deps.dropPrivileges,
        env: deps.env,
      });
    } catch {
      deps.onChunk(
        "setup",
        `[deno cache] not available (${cachePath}) — deno will fetch deps on first run\r\n`,
      );
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  })();
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
