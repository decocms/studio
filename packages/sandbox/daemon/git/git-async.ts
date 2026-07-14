import { spawn, type SpawnOptions } from "node:child_process";
import { DECO_UID, DECO_GID } from "../constants";
import type { GitError, GitSyncOpts } from "./git-sync";

const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/**
 * Async twin of {@link gitSync}. Same semantics (drops to deco:1000 unless
 * `asUser: false`, 30 s default timeout, throws {@link GitError} on non-zero
 * exit) but backed by `child_process.spawn` so it NEVER blocks the daemon's
 * single Bun event loop.
 *
 * This matters on the hot read paths (git/diff, git/status): `spawnSync` freezes
 * the whole daemon for the duration of the child — a slow `git fetch` (PR-diff
 * deepening on a repo with large blobs) can block for ~10 s, during which the
 * upstream HEAD probe can't run and the sandbox gets mis-flagged as crashed
 * (surfaced as a 502 on the very next status poll). Streaming stdout also
 * sidesteps `spawnSync`'s maxBuffer truncation on large `git show` output.
 */
export function gitAsync(args: string[], opts: GitSyncOpts): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // uid/gid: Linux-only concept, same gate as pty-spawn.ts / git-sync.ts.
    const asUser = opts.asUser !== false && process.platform === "linux";
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    };
    if (asUser) {
      spawnOpts.uid = DECO_UID;
      spawnOpts.gid = DECO_GID;
    }

    const child = spawn("git", args, spawnOpts);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));

    child.on("error", (e: Error) => {
      const gitErr = new Error(
        `git ${args.join(" ")}: ${e.message}`,
      ) as GitError;
      gitErr.stderr = Buffer.concat(err).toString("utf-8");
      gitErr.status = -1;
      reject(gitErr);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const stderr = Buffer.concat(err).toString("utf-8");
      if (code === 0) {
        resolve(Buffer.concat(out).toString("utf-8").trim());
        return;
      }
      const reason = signal ? ` (killed by ${signal})` : "";
      const gitErr = new Error(
        `git ${args.join(" ")} exited ${code}${reason}${
          stderr ? `: ${stderr.trim()}` : ""
        }`,
      ) as GitError;
      gitErr.stderr = stderr;
      gitErr.status = code ?? -1;
      reject(gitErr);
    });
  });
}
