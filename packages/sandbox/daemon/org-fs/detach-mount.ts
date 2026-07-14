/**
 * Detach commands to try, in order, for `mountPath`. Pure so the flag choice is
 * unit-testable without spawning. Every command is the NON-BLOCKING variant:
 * Linux `fusermount -uz` / `umount -l` and macOS `umount -f` all return
 * immediately and let the kernel finish cleanup once references drop. A plain
 * `fusermount -u` / `umount` instead blocks in-kernel while the FUSE server
 * flushes (up to the spawnSync timeout below). That matters because MountManager
 * unmounts run this synchronously with no internal await, so several blocking
 * detaches serialize and can overrun the pod's terminationGracePeriod → the
 * sidecar is SIGKILLed (exit 137) instead of exiting 0.
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
    // wedged kernel must never hang the daemon.
    const p = Bun.spawnSync(cmd, {
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5000,
    });
    if (p.exitCode === 0) break;
  }
}
