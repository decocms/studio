import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { DECO_UID, DECO_GID } from "../constants";

export interface GitSyncOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** When true (default), drops to deco:1000/1000. Set false for system-level git config as root. */
  asUser?: boolean;
  /** Kill the git process after this many ms. Default: 30 000 (30 s). */
  timeoutMs?: number;
}

export interface GitError extends Error {
  stderr: string;
  status: number;
}

const DEFAULT_GIT_TIMEOUT_MS = 30_000;

export function gitSync(args: string[], opts: GitSyncOpts): string {
  // uid/gid: Linux-only concept, same gate as pty-spawn.ts. Setting them on
  // win32 has no effect (Node docs: unsupported there); on macOS a non-root
  // daemon can't setuid anyway — Bun's child_process shim currently swallows
  // that as a silent no-op, but Node's does not (throws EPERM), so gate hard
  // rather than depend on that runtime detail.
  const asUser = opts.asUser !== false && process.platform === "linux";
  const spawnOpts: SpawnSyncOptions = {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  };
  if (asUser) {
    spawnOpts.uid = DECO_UID;
    spawnOpts.gid = DECO_GID;
  }
  const res = spawnSync("git", args, spawnOpts);
  if (res.error) {
    const err = new Error(
      `git ${args.join(" ")}: ${res.error.message}`,
    ) as GitError;
    err.stderr = String(res.stderr ?? "");
    err.status = -1;
    throw err;
  }
  if (res.status !== 0) {
    const err = new Error(
      `git ${args.join(" ")} exited ${res.status}${res.stderr ? `: ${String(res.stderr).trim()}` : ""}`,
    ) as GitError;
    err.stderr = String(res.stderr ?? "");
    err.status = res.status ?? -1;
    throw err;
  }
  return String(res.stdout ?? "").trim();
}
