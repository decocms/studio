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
 */
export function detachMount(mountPath: string, isMac: boolean): void {
  // No org-fs mount is ever established on Windows (see mounter.ts's win32
  // guard), and neither `umount` nor `fusermount` exist there — so this is
  // reachable pre-mount too (entry.ts's exit handler calls it unconditionally
  // for every tracked mount path). No-op rather than spawn a binary that
  // doesn't exist.
  if (process.platform === "win32") return;
  for (const cmd of detachCommands(mountPath, isMac)) {
    // Keep the timeout as a backstop even though every command is lazy: a
    // wedged kernel must never hang the daemon. Blocking (spawnSync) is
    // acceptable ONLY here: this is entry.ts's synchronous `process.on("exit")`
    // backstop, which by Node/Bun contract cannot await a Promise anyway.
    const p = Bun.spawnSync(cmd, {
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5000,
    });
    if (p.exitCode === 0) break;
  }
}

/**
 * Async twin of {@link detachMount} for every OTHER call site (mounter.ts's
 * `mount()` reclaim and `unmount()`), which run on the daemon's live event
 * loop rather than in the exit handler. `Bun.spawnSync` there froze the whole
 * daemon for the command's full duration (up to two 5 s timeouts on Linux) —
 * on the very reclaim path documented above as handling a wedged/stale mount,
 * i.e. exactly when the command is most likely to actually hit its timeout.
 * A single missed health probe during that freeze flips a healthy sandbox to
 * "crashed" (see CONTRIBUTING.md). `node:child_process.spawn` never blocks the
 * loop, mirroring git-async.ts's fix for the same class of bug in git-sync.ts.
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
