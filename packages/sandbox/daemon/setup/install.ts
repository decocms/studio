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

/**
 * For Deno projects, tries to pre-populate $DENO_DIR from a pre-signed S3 URL
 * provided by mesh. The URL is scoped to exactly one object (owner/repo/cache.tar.zst)
 * and expires in 15 minutes — no AWS credentials needed in the sandbox pod.
 *
 * Non-fatal: any failure (URL expired, object not found, network error) is logged
 * and the sandbox continues to start normally.
 */
export function tryWarmDenoCache(deps: InstallDeps): Promise<void> | null {
  const { config } = deps;
  if (config.application?.packageManager?.name !== "deno") return null;

  const presignedUrl = config.denoCache?.presignedUrl;
  if (!presignedUrl) return null;

  return (async () => {
    deps.onChunk(
      "setup",
      "\r\n[deno cache] fetching from pre-signed URL...\r\n",
    );

    let tmpDir: string | null = null;
    try {
      const res = await fetch(presignedUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error("empty response body");

      tmpDir = await mkdtemp(join(tmpdir(), "deco-cache-"));
      const tmpFile = join(tmpDir, "cache.tar.zst");
      const ws = createWriteStream(tmpFile);
      await pipeline(res.body as unknown as NodeJS.ReadableStream, ws);

      const denoDir =
        deps.env?.DENO_DIR ?? process.env.DENO_DIR ?? join(homedir(), ".deno");
      const cmd = [
        `mkdir -p "${denoDir}"`,
        `zstd -d "${tmpFile}" --stdout | tar xf - -C "${denoDir}" --no-same-permissions --no-same-owner`,
        `echo "[deno cache] restored from S3"`,
      ].join(" && ");

      await spawnSetupStep(cmd, deps.onChunk, {
        dropPrivileges: deps.dropPrivileges,
        env: deps.env,
      });
    } catch {
      deps.onChunk(
        "setup",
        "[deno cache] not available — deno will fetch deps on first run\r\n",
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
