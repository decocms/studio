import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PACKAGE_MANAGER_DAEMON_CONFIG } from "../constants";
import { resolvePmRoot } from "../paths";
import type { Config } from "../types";
import { spawnSetupStep } from "./spawn-step";

const S3_CACHE_DIRS: Record<
  string,
  (env?: Readonly<Record<string, string>>) => string
> = {
  deno: (env) => env?.DENO_DIR ?? join(homedir(), ".deno"),
  bun: () => join(homedir(), ".bun", "install", "cache"),
  npm: () => join(homedir(), ".npm"),
  pnpm: () => join(homedir(), ".local", "share", "pnpm", "store", "v3"),
};

/**
 * Tries to restore the package manager cache from S3 before install.
 * Uses a pre-signed GET URL from TenantConfig — no AWS credentials needed.
 * Non-fatal: any failure is logged and the sandbox continues normally.
 */
export function tryRestoreS3Cache(deps: InstallDeps): Promise<void> | null {
  const { config } = deps;
  const pm = config.application?.packageManager?.name;
  if (!pm) return null;
  const getCacheDir = S3_CACHE_DIRS[pm];
  if (!getCacheDir) return null;
  const getUrl = config.s3Cache?.getUrl;
  if (!getUrl) return null;

  return (async () => {
    deps.onChunk("setup", `\r\n[s3 cache] restoring ${pm} cache...\r\n`);
    let tmpDir: string | null = null;
    try {
      const res = await fetch(getUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error("empty response body");

      tmpDir = await mkdtemp(join(tmpdir(), "deco-cache-"));
      const tmpFile = join(tmpDir, "cache.tar.zst");
      const ws = createWriteStream(tmpFile);
      await pipeline(res.body as unknown as NodeJS.ReadableStream, ws);

      const cacheDir = getCacheDir(deps.env);
      const cmd = [
        `mkdir -p "${cacheDir}"`,
        `zstd -d "${tmpFile}" --stdout | tar xf - -C "${cacheDir}" --no-same-permissions --no-same-owner`,
        `echo "[s3 cache] restored ${pm} cache"`,
      ].join(" && ");

      await spawnSetupStep(cmd, deps.onChunk, {
        dropPrivileges: deps.dropPrivileges,
        env: deps.env,
      });
    } catch {
      deps.onChunk("setup", `[s3 cache] not available — cold start\r\n`);
    } finally {
      if (tmpDir)
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

/**
 * Uploads the package manager cache to S3 after a successful install.
 * Uses a pre-signed PUT URL from TenantConfig — no AWS credentials needed.
 * Non-fatal: any failure is logged and does not affect the sandbox.
 */
export function tryUploadS3Cache(deps: InstallDeps): Promise<void> | null {
  const { config } = deps;
  const pm = config.application?.packageManager?.name;
  if (!pm) return null;
  const getCacheDir = S3_CACHE_DIRS[pm];
  if (!getCacheDir) return null;
  const putUrl = config.s3Cache?.putUrl;
  if (!putUrl) return null;

  return (async () => {
    deps.onChunk("setup", `\r\n[s3 cache] uploading ${pm} cache...\r\n`);
    let tmpDir: string | null = null;
    try {
      const cacheDir = getCacheDir(deps.env);
      tmpDir = await mkdtemp(join(tmpdir(), "deco-cache-"));
      const tmpFile = join(tmpDir, "cache.tar.zst");

      const code = await spawnSetupStep(
        `tar cf - -C "${cacheDir}" . | zstd -o "${tmpFile}"`,
        deps.onChunk,
        { dropPrivileges: deps.dropPrivileges, env: deps.env },
      );
      if (code !== 0) throw new Error(`tar/zstd exited ${code}`);

      const body = await readFile(tmpFile);
      const res = await fetch(putUrl, {
        method: "PUT",
        body,
        headers: { "Content-Length": String(body.byteLength) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      deps.onChunk("setup", `[s3 cache] uploaded ${pm} cache\r\n`);
    } catch (err) {
      deps.onChunk(
        "setup",
        `[s3 cache] upload failed — ${(err as Error).message}\r\n`,
      );
    } finally {
      if (tmpDir)
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
