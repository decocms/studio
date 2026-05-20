import { spawn as nodeSpawn } from "node:child_process";
import { DECO_GID, DECO_UID } from "../constants";

/**
 * Runs one-shot setup commands (git clone, git checkout, npm install, etc.)
 * via `child_process.spawn` — NOT through node-pty. node-pty's forkpty can
 * fail deterministically on some hosts (observed: bun + libuv on macOS
 * throws `posix_spawnp failed`), and setup commands don't need a TTY anyway.
 *
 * Uses Node's `child_process.spawn` rather than `Bun.spawn` because Bun's
 * spawn doesn't expose `uid`/`gid` options, and we need to drop privileges
 * to `DECO_UID:DECO_GID` before running untrusted install scripts.
 *
 * The dev server itself still uses `spawnPty` (in task-manager.ts) because
 * it benefits from colored output and progress bars.
 *
 * stdout/stderr are interleaved into the onChunk stream so callers see the
 * same log shape as the previous PTY-backed implementation.
 */
export function spawnSetupStep(
  cmd: string,
  onChunk: (source: "setup", data: string) => void,
  dropPrivileges?: boolean,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn("sh", ["-c", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(dropPrivileges ? { uid: DECO_UID, gid: DECO_GID } : {}),
    });
    child.stdout?.on("data", (data: Buffer) =>
      onChunk("setup", data.toString("utf8")),
    );
    child.stderr?.on("data", (data: Buffer) =>
      onChunk("setup", data.toString("utf8")),
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== null) resolve(code);
      else if (signal) resolve(128 + (signal === "SIGTERM" ? 15 : 1));
      else resolve(1);
    });
  });
}
