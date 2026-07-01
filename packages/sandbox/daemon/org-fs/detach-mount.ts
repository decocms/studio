/**
 * Force-detach whatever is mounted at `mountPath` (best-effort, never throws).
 * Used both to tear down our own mount and to reclaim a stale ghost left by a
 * previously-killed session before mounting fresh. On a path that isn't a mount
 * point every command exits non-zero and we simply move on.
 */
export function detachMount(mountPath: string, isMac: boolean): void {
  // NFS + FUSE both unmount via `umount`; on Linux `fusermount -u` is the
  // unprivileged path, so try it first there.
  const cmds: string[][] = isMac
    ? [["umount", "-f", mountPath]]
    : [
        ["fusermount", "-u", mountPath],
        ["umount", mountPath],
      ];
  for (const cmd of cmds) {
    // `umount -f` is the non-blocking force path, but bound it anyway: this
    // runs on every mount (reclaim) and at shutdown, and a wedged kernel
    // unmount must never hang the daemon.
    const p = Bun.spawnSync(cmd, {
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5000,
    });
    if (p.exitCode === 0) break;
  }
}
