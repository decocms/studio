import { spawn as nodeSpawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { DECO_GID, DECO_UID } from "../constants";

// child_process.spawn: avoids node-pty forkpty failures on macOS/bun and
// supports uid/gid drops that Bun.spawn lacks.
export function spawnSetupStep(
  cmd: string,
  onChunk: (source: "setup", data: string) => void,
  dropPrivileges?: boolean,
): Promise<number> {
  return new Promise((resolve) => {
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
    child.on("error", (err) => {
      onChunk("setup", `[spawn error] ${err.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (code !== null) resolve(code);
      else if (signal)
        resolve(128 + (osConstants.signals[signal as NodeJS.Signals] ?? 1));
      else resolve(1);
    });
  });
}
