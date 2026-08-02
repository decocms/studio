import { spawn } from "node:child_process";

/**
 * Detach commands to try, in order, for `mountPath`. Pure so the flag choice is
 * unit-testable without spawning. Every command is the NON-BLOCKING variant:
 * Linux `fusermount -uz` / `umount -l` and macOS `umount -f` all return
 * immediately and let the kernel finish cleanup once references drop. A plain
 * `fusermount -u` / `umount` instead blocks in-kernel while the FUSE server
 * flushes (up to the timeout below). That matters because a wedged detach can
 * overrun the pod's terminationGracePeriod → the sidecar is SIGKILLed (exit
 * 137) instead of exiting 0.
 */
export function detachCommands(mountPath: string, isMac: boolean): string[][] {
  return isMac
    ? [["umount", "-f", mountPath]]
    : [
        ["fusermount", "-uz", mountPath],
        ["umount", "-l", mountPath],
      ];
}

/**
 * Force-detach whatever is mounted at `mountPath` (best-effort, never throws).
 * Used both to tear down our own mount and to reclaim a stale ghost left by a
 * previously-killed session before mounting fresh. On a path that isn't a mount
 * point every command exits non-zero and we simply move on.
 *
 * Never blocking: `mount()`'s reclaim and `unmount()` run on the sidecar's live
 * event loop, and a `spawnSync` here froze it for the command's full duration
 * (up to two 5 s timeouts on Linux) — on the very reclaim path that handles a
 * wedged mount, i.e. exactly when the timeout is most likely to be hit.
 */
export async function detachMountAsync(
  mountPath: string,
  isMac: boolean,
): Promise<void> {
  if (process.platform === "win32") return;
  for (const cmd of detachCommands(mountPath, isMac)) {
    const code = await runDetachCommand(cmd, 5000);
    if (code === 0) break;
  }
}

/**
 * Run one detach command without blocking the event loop; never rejects.
 * Exported (like {@link detachCommands}) so the non-blocking behavior itself
 * is unit-testable without a real fusermount/umount.
 */
export function runDetachCommand(
  cmd: string[],
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      stdio: "ignore",
      timeout: timeoutMs,
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
