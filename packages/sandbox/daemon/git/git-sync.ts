import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { DECO_UID, DECO_GID } from "../constants";

export interface GitSyncOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** When true (default), drops to deco:1000/1000. Set false for system-level git config as root. */
  asUser?: boolean;
  /** Kill the git process after this many ms. Default: 60 000 (60 s). */
  timeoutMs?: number;
}

export interface GitError extends Error {
  stderr: string;
  status: number;
}

const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export function gitSync(args: string[], opts: GitSyncOpts): string {
  const asUser = opts.asUser !== false;
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
