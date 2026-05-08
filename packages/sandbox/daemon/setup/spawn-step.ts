import { DECO_GID, DECO_UID } from "../constants";
import { spawnPty } from "../process/pty-spawn";

export function spawnSetupStep(
  cmd: string,
  onChunk: (source: "setup", data: string) => void,
  dropPrivileges?: boolean,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnPty({
      cmd,
      ...(dropPrivileges ? { uid: DECO_UID, gid: DECO_GID } : {}),
    });
    child.onData((data) => onChunk("setup", data));
    child.onExit((code) => resolve(code));
  });
}
