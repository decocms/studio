/**
 * The real `Mounter`: has the OS mount a loopback WebDAV URL via rclone, with
 * no kernel extension required.
 *
 *   macOS  → `rclone nfsmount` (built-in NFS client; no macFUSE/System Extension)
 *   Linux  → `rclone mount`    (native FUSE via /dev/fuse; no install)
 *
 * rclone reads the WebDAV server via an env-config remote ("wd:") — the
 * connection-string form breaks on the URL's colons — and `--vfs-cache-mode
 * full` gives the lazy per-file fetch + write-back. When an `rcAddr` is given,
 * rclone also exposes its control API there so the invalidator can drive
 * `vfs/forget` for near-realtime freshness.
 *
 * rclone runs in the FOREGROUND (not `--daemon`): `mount --rc --daemon` is
 * broken in rclone (the launcher hangs and never attaches the mount), so we
 * keep rclone as a managed child and wait for the mount to come up via the rc
 * API instead of awaiting the launcher's exit. `unmount()` detaches the OS
 * mount and kills the child.
 *
 * `rclonePath` must point at a real rclone binary with mount support (the
 * Homebrew build notably lacks it). When rclone isn't available the daemon
 * should not construct this — see MountManager (mounting is then skipped).
 */

import { sleep } from "@decocms/std";
import type { MountHandle, Mounter } from "./mount-manager";

/** How long to wait for the mount to attach before giving up. */
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;

export function createRcloneMounter(rclonePath: string): Mounter {
  const isMac = process.platform === "darwin";
  return {
    async mount({ webdavUrl, mountPath, rcAddr }) {
      const args = isMac
        ? ["nfsmount", "wd:", mountPath]
        : ["mount", "wd:", mountPath];
      const rcArgs = rcAddr
        ? ["--rc", "--rc-addr", rcAddr, "--rc-no-auth"]
        : [];
      const proc = Bun.spawn(
        [
          rclonePath,
          ...args,
          "--vfs-cache-mode",
          "full",
          // Safety-net TTL if the invalidator isn't running or misses a change;
          // the change-feed-driven vfs/forget (invalidator.ts) is what makes
          // external writes show up in ~1s.
          "--dir-cache-time",
          "10s",
          ...rcArgs,
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
      try {
        await waitForMount(proc, rcAddr, args[0]!, mountPath);
      } catch (err) {
        proc.kill();
        throw err;
      }
      return makeHandle(proc, mountPath, isMac);
    },
  };
}

/**
 * Resolve once the mount is live. With an rc address, poll `vfs/list` until a
 * VFS is registered (mount attached); without one, fall back to a short grace
 * wait. Throws if rclone exits early (mount failed) or the deadline passes.
 */
async function waitForMount(
  proc: { exitCode: number | null; exited: Promise<number> },
  rcAddr: string | undefined,
  subcommand: string,
  mountPath: string,
): Promise<void> {
  if (!rcAddr) {
    await sleep(1000);
    if (proc.exitCode !== null) {
      throw new Error(`rclone ${subcommand} exited ${proc.exitCode}`);
    }
    return;
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `rclone ${subcommand} exited ${proc.exitCode} before mounting ${mountPath}`,
      );
    }
    try {
      const res = await fetch(`http://${rcAddr}/vfs/list`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        const body = (await res.json()) as { vfses?: string[] };
        if (Array.isArray(body.vfses) && body.vfses.length > 0) return;
      }
    } catch {
      // rc server not up yet — keep polling.
    }
    await sleep(READY_POLL_MS);
  }
  throw new Error(`rclone ${subcommand} not ready for ${mountPath} in time`);
}

function makeHandle(
  proc: { kill: () => void; exited: Promise<number> },
  mountPath: string,
  isMac: boolean,
): MountHandle {
  return {
    async unmount() {
      // Detach the OS mount first; NFS + FUSE both unmount via `umount`, and on
      // Linux `fusermount -u` is the unprivileged path, so try it first there.
      const cmds: string[][] = isMac
        ? [["umount", "-f", mountPath]]
        : [
            ["fusermount", "-u", mountPath],
            ["umount", mountPath],
          ];
      for (const cmd of cmds) {
        const p = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" });
        if (p.exitCode === 0) break;
      }
      // Then stop the foreground rclone child.
      try {
        proc.kill();
      } catch {
        // already gone
      }
      await proc.exited.catch(() => {});
    },
  };
}
