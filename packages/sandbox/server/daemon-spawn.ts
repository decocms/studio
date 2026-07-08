/**
 * Shared daemon spawn / executable resolution.
 *
 * Used by the `deco link` daemon (desktop-side, where the link binary
 * fronts the sandbox daemon for the cluster's remote-harness dispatcher).
 *
 * In dev (source tree present), spawn `bun run <daemon/entry.ts>` so the
 * daemon code reloads on file change without a build step.
 *
 * In production (the link binary, or `bunx decocms@latest`), the source
 * TS path resolves to a nonexistent `<bunx-cache>/.../daemon/entry.ts` —
 * we materialize the embedded bundle (loaded lazily from
 * `daemon-asset.ts`) into `<homeDir>/cache/sandbox-daemon-<hash>.js`
 * and spawn that.
 *
 * `node-pty` is a runtime dep of the daemon. Its install location lives
 * inside the parent's node_modules tree, but the materialized bundle
 * sits in DATA_DIR — bun won't find node-pty by walking up from there.
 * `resolveNodePtyNodeModulesDir` returns the directory to expose via
 * NODE_PATH so the spawned daemon can `import "node-pty"`.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
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

/**
 * Matches on `/` or `\` regardless of host OS: Bun.resolveSync returns
 * native separators (backslashes on Windows), but we also want this
 * derivation to be unit-testable with Windows-style paths from any host.
 */
export function deriveNodeModulesDir(entryPath: string): string {
  const dir = /^(.*[/\\]node_modules)[/\\]/.exec(entryPath)?.[1];
  if (!dir) {
    throw new Error(
      `could not derive node_modules path from node-pty resolution: ${entryPath}`,
    );
  }
  return dir;
}

export function resolveNodePtyNodeModulesDir(): string {
  return deriveNodeModulesDir(Bun.resolveSync("node-pty", import.meta.dir));
}

export async function materializeDaemonBundle(
  homeDir: string,
): Promise<string> {
  const { DAEMON_BUNDLE } = await import("./daemon-asset");
  const hash = createHash("sha256")
    .update(DAEMON_BUNDLE)
    .digest("hex")
    .slice(0, 16);
  const cacheDir = join(homeDir, "cache");
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
 * Resolve the stdout/stderr target for the spawned daemon. With no `outFd`
 * the child inherits the parent's terminal fds (the default — used by
 * `--no-tui` and the managed/dev daemon, whose output is meant to stream to
 * the parent). When the `deco link` TUI is active the caller passes a
 * log-file fd so the child's output lands in a file instead of corrupting
 * the Ink canvas.
 */
export function resolveDaemonStdio(outFd?: number): "inherit" | number {
  return outFd ?? "inherit";
}

/**
 * Per-sandbox daemon log path: `<workdir>/tmp/daemon.log`. Each spawned sandbox
 * daemon writes its stdout/stderr here — co-located with the sandbox's `repo/`
 * and isolated from every other sandbox (the old single combined file
 * interleaved them all). Truncated on every spawn (see `createDefaultDaemonSpawn`).
 */
export function sandboxDaemonLogPath(workdir: string): string {
  return join(workdir, "tmp", "daemon.log");
}

export function canHotReloadDaemon(opts: {
  daemonExec: string;
  sourceDaemonPath: string;
  hotReload?: boolean;
}): boolean {
  return (
    opts.hotReload === true &&
    resolve(opts.daemonExec) === resolve(opts.sourceDaemonPath)
  );
}

export function buildSandboxDaemonSpawnCommand(opts: {
  daemonExec: string;
  sourceDaemonPath: string;
  hotReload?: boolean;
}): string[] {
  const hotFromSource = canHotReloadDaemon(opts);
  return ["bun", ...(hotFromSource ? ["--hot"] : []), "run", opts.daemonExec];
}

/**
 * Default Bun.spawn-based daemon launcher. `homeDir` is the DATA_DIR
 * root used to materialize the daemon bundle when running from a bundle.
 */
export function createDefaultDaemonSpawn(
  homeDir: string,
  opts: { outFd?: number; perSandboxLog?: boolean; hotReload?: boolean } = {},
): SpawnDaemonFn {
  return async (args) => {
    const daemonExec = await resolveDaemonExec(homeDir);
    const sourceDaemonPath = resolveSourceDaemonPath();
    const ptyNodeModulesDir = resolveNodePtyNodeModulesDir();
    const existingNodePath = process.env.NODE_PATH;
    const nodePath = existingNodePath
      ? `${ptyNodeModulesDir}${delimiter}${existingNodePath}`
      : ptyNodeModulesDir;
    // Per-sandbox log: open `<workdir>/tmp/daemon.log` (truncate every spawn)
    // and point this sandbox daemon's stdout/stderr at it, so each sandbox's
    // (noisy) output is isolated + co-located with its repo. Falls back to
    // `outFd`/terminal-inherit for managed/dev mode, where output is meant to
    // stream to the parent process.
    let perSandboxFd: number | undefined;
    let stdio: "inherit" | number;
    if (opts.perSandboxLog) {
      const logPath = sandboxDaemonLogPath(args.workdir);
      mkdirSync(dirname(logPath), { recursive: true });
      perSandboxFd = openSync(logPath, "w");
      stdio = perSandboxFd;
      console.log(`[user-desktop] sandbox daemon logs → ${logPath}`);
    } else {
      stdio = resolveDaemonStdio(opts.outFd);
    }
    const proc = Bun.spawn({
      cmd: buildSandboxDaemonSpawnCommand({
        daemonExec,
        sourceDaemonPath,
        hotReload: opts.hotReload,
      }),
      env: {
        ...process.env,
        NODE_PATH: nodePath,
        ...args.env,
      },
      stdout: stdio,
      stderr: stdio,
      stdin: "ignore",
    });
    // Close the parent's copy of the log fd once the child exits — the child
    // holds its own dup for its lifetime, so this only releases our handle.
    if (perSandboxFd !== undefined) {
      const fd = perSandboxFd;
      void proc.exited.finally(() => {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      });
    }
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
