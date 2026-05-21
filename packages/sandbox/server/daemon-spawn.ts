/**
 * Shared daemon spawn / executable resolution.
 *
 * Used by the `deco link` daemon (laptop-side, where the link binary
 * fronts the sandbox daemon for the cluster's remote-harness dispatcher).
 *
 * In dev (source tree present), spawn `bun run <daemon/entry.ts>` so the
 * daemon code reloads on file change without a build step.
 *
 * In production (the link binary, or `bunx decocms@latest`), the source
 * TS path resolves to a nonexistent `<bunx-cache>/.../daemon/entry.ts` —
 * we materialize the embedded bundle (loaded lazily from
 * `daemon-asset.ts`) into `<homeDir>/.deco/cache/sandbox-daemon-<hash>.js`
 * and spawn that.
 *
 * `node-pty` is a runtime dep of the daemon. Its install location lives
 * inside the parent's node_modules tree, but the materialized bundle
 * sits in DATA_DIR — bun won't find node-pty by walking up from there.
 * `resolveNodePtyNodeModulesDir` returns the directory to expose via
 * NODE_PATH so the spawned daemon can `import "node-pty"`.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DaemonProcess {
  pid: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  /** Bun's Subprocess.exited — resolves with the exit code when the
   *  process terminates. */
  exited: Promise<number>;
}

export interface SpawnDaemonInput {
  workdir: string;
  env: Record<string, string>;
  /** Port the daemon should bind to (PROXY_PORT). */
  daemonPort: number;
}

export type SpawnDaemonFn = (input: SpawnDaemonInput) => Promise<DaemonProcess>;

export function resolveSourceDaemonPath(): string {
  return resolve(fileURLToPath(new URL("../daemon/entry.ts", import.meta.url)));
}

export function resolveNodePtyNodeModulesDir(): string {
  const ptyEntry = Bun.resolveSync("node-pty", import.meta.dir);
  const marker = "/node_modules/";
  const idx = ptyEntry.lastIndexOf(marker);
  if (idx < 0) {
    throw new Error(
      `could not derive node_modules path from node-pty resolution: ${ptyEntry}`,
    );
  }
  return ptyEntry.slice(0, idx + marker.length - 1);
}

export async function materializeDaemonBundle(
  homeDir: string,
): Promise<string> {
  const { DAEMON_BUNDLE } = await import("./daemon-asset");
  const hash = createHash("sha256")
    .update(DAEMON_BUNDLE)
    .digest("hex")
    .slice(0, 16);
  const cacheDir = join(homeDir, ".deco", "cache");
  const cachePath = join(cacheDir, `sandbox-daemon-${hash}.js`);
  if (existsSync(cachePath)) return cachePath;
  await mkdir(cacheDir, { recursive: true });
  // Write atomically — concurrent spawns racing to materialize the same
  // hashed file are tolerated because `rename` is atomic on POSIX.
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, DAEMON_BUNDLE);
  await rename(tmpPath, cachePath);
  return cachePath;
}

export async function resolveDaemonExec(homeDir: string): Promise<string> {
  const sourceTs = resolveSourceDaemonPath();
  if (existsSync(sourceTs)) return sourceTs;
  return materializeDaemonBundle(homeDir);
}

/**
 * Default Bun.spawn-based daemon launcher. `homeDir` is the DATA_DIR
 * root used to materialize the daemon bundle when running from a bundle.
 */
export function createDefaultDaemonSpawn(homeDir: string): SpawnDaemonFn {
  return async (args) => {
    const daemonExec = await resolveDaemonExec(homeDir);
    const ptyNodeModulesDir = resolveNodePtyNodeModulesDir();
    const existingNodePath = process.env.NODE_PATH;
    const nodePath = existingNodePath
      ? `${ptyNodeModulesDir}:${existingNodePath}`
      : ptyNodeModulesDir;
    const proc = Bun.spawn({
      cmd: ["bun", "run", daemonExec],
      env: {
        ...process.env,
        NODE_PATH: nodePath,
        ...args.env,
      },
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
    return {
      pid: proc.pid,
      kill: (sig) => {
        proc.kill(sig as NodeJS.Signals | number | undefined);
        return true;
      },
      exited: proc.exited,
    };
  };
}
