/**
 * The real `Mounter`: has the OS mount a loopback WebDAV URL via rclone, with
 * no kernel extension required.
 *
 *   macOS  → `rclone nfsmount` (built-in NFS client; no macFUSE/System Extension)
 *   Linux  → `rclone mount`    (native FUSE via /dev/fuse; no install)
 *
 * rclone reads the WebDAV server via an env-config remote ("wd:") — the
 * connection-string form breaks on the URL's colons — and `--vfs-cache-mode
 * full` gives the lazy per-file fetch + write-back. Mounting is daemonized so
 * the spawn returns immediately; the mount runs detached until `unmount()`.
 *
 * `rclonePath` must point at a real rclone binary with mount support (the
 * Homebrew build notably lacks it). When rclone isn't available the daemon
 * should not construct this — see MountManager (mounting is then skipped).
 */

import type { MountHandle, Mounter } from "./mount-manager";

export function createRcloneMounter(rclonePath: string): Mounter {
  const isMac = process.platform === "darwin";
  return {
    async mount({ webdavUrl, mountPath }) {
      const args = isMac
        ? ["nfsmount", "wd:", mountPath]
        : ["mount", "wd:", mountPath];
      const proc = Bun.spawn(
        [
          rclonePath,
          ...args,
          "--vfs-cache-mode",
          "full",
          "--daemon",
          "--daemon-timeout=30s",
        ],
        {
          env: {
            ...process.env,
            RCLONE_CONFIG_WD_TYPE: "webdav",
            RCLONE_CONFIG_WD_URL: webdavUrl,
            RCLONE_CONFIG_WD_VENDOR: "other",
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      // `--daemon` forks rclone and the launcher exits; await that exit.
      const code = await proc.exited;
      if (code !== 0) {
        throw new Error(`rclone ${args[0]} exited ${code} for ${mountPath}`);
      }
      return makeHandle(mountPath, isMac);
    },
  };
}

function makeHandle(mountPath: string, isMac: boolean): MountHandle {
  return {
    async unmount() {
      // NFS + FUSE both unmount via `umount`; on Linux `fusermount -u` is the
      // unprivileged path for a FUSE mount, so try it first there.
      const cmds: string[][] = isMac
        ? [["umount", "-f", mountPath]]
        : [
            ["fusermount", "-u", mountPath],
            ["umount", mountPath],
          ];
      for (const cmd of cmds) {
        const p = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" });
        if (p.exitCode === 0) return;
      }
    },
  };
}
