import { DECO_GID, DECO_UID } from "../constants";
import { spawnPty } from "../process/pty-spawn";

export interface SpawnSetupStepOpts {
  dropPrivileges?: boolean;
  /** Extra env merged on top of the daemon's process.env. */
  env?: Readonly<Record<string, string>>;
}

export function spawnSetupStep(
  cmd: string,
  onChunk: (source: "setup", data: string) => void,
  opts: SpawnSetupStepOpts = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnPty({
      cmd,
      ...(opts.dropPrivileges ? { uid: DECO_UID, gid: DECO_GID } : {}),
      ...(opts.env ? { env: opts.env as NodeJS.ProcessEnv } : {}),
    });
    child.onData((data) => onChunk("setup", data));
    child.onExit((code) => resolve(code));
  });
}
