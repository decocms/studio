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
 * `vfs/refresh` for near-realtime freshness.
 *
 * rclone runs in the FOREGROUND (not `--daemon`): `mount --rc --daemon` is
 * broken in rclone (the launcher hangs and never attaches the mount), so we
 * keep rclone as a managed child and wait for the mount to come up via the rc
 * API instead of awaiting the launcher's exit. `unmount()` detaches the OS
 * mount and kills the child.
 *
 * macOS staleness: an NFS mount survives the rclone process that served it, so
 * any ungraceful exit (SIGKILL, crash, sleep) leaves a ghost mount that hangs
 * I/O and pops the "Server connections interrupted" dialog. Two defenses live
 * here: `mount()` force-detaches any stale mount at the path before mounting
 * (reclaim), and the macOS mount is `soft` with a bounded `timeo` so a dead
 * server fails fast instead of hanging forever (FUSE on Linux already does this
 * via ENOTCONN).
 *
 * `rclonePath` must point at a real rclone binary with mount support (the
 * Homebrew build notably lacks it). When rclone isn't available the daemon
 * should not construct this — see MountManager (mounting is then skipped).
 */

import { sleep } from "@decocms/shared/std";
import { detachMountAsync } from "./detach-mount";
import type { MountHandle, Mounter } from "./mount-manager";

export { detachMount } from "./detach-mount";

/** How long to wait for the mount to attach before giving up. */
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;

/**
 * macOS `mount_nfs` options (passed through rclone `nfsmount --option`):
 *  - actimeo=1: the macOS NFS client caches dir/file attributes ~5s by default,
 *    which would mask the invalidator's freshness; 1s is cheap against a
 *    loopback server.
 *  - locallocks: rclone's NFS server has no lock daemon (NLM), so apps that take
 *    file locks (sqlite, editors) would hang against it. The mount is strictly
 *    single-client (loopback), so client-local lock semantics are exact.
 *  - soft: return an I/O error once a request exhausts its retransmissions
 *    instead of blocking forever. Safe here because the server is loopback —
 *    healthy it answers in microseconds, dead it refuses the connection — so
 *    this only ever trips when rclone is genuinely gone, turning the classic NFS
 *    hard-mount hang (+ persistent reconnect dialog) into a fast, recoverable
 *    error. Writes land in rclone's local VFS cache first, so a slow studio never
 *    makes a write slow enough to trip this.
 *  - timeo=100 (tenths of a sec → 10s) / retrans=2: generous per-request
 *    headroom so a legitimately slow read (first open of a large uncached file
 *    that rclone must fetch whole from the studio) is not killed, while still
 *    bounding a dead-server hang to ~tens of seconds. Tuning knob: lower timeo
 *    for snappier dead-mount recovery only if large-read tests still pass.
 *  - nobrowse: keep the volume out of the Finder sidebar/desktop, reducing the
 *    surface for Finder-driven reconnect prompts.
 */
const MAC_NFS_OPTIONS =
  "actimeo=1,locallocks,soft,timeo=100,retrans=2,nobrowse";

/**
 * Build the full rclone argv (everything after the binary path). Pure so the
 * option set is unit-testable without spawning rclone.
 */
export function buildMountArgs(opts: {
  isMac: boolean;
  mountPath: string;
  /** FUSE `--allow-other` (Linux only). */
  allowOther?: boolean;
  readonly?: boolean;
  rcAddr?: string;
}): string[] {
  const mountArgs = opts.isMac
    ? ["nfsmount", "wd:", opts.mountPath, "--option", MAC_NFS_OPTIONS]
    : [
        "mount",
        "wd:",
        opts.mountPath,
        ...(opts.allowOther ? ["--allow-other"] : []),
      ];
  const rcArgs = opts.rcAddr
    ? ["--rc", "--rc-addr", opts.rcAddr, "--rc-no-auth"]
    : [];
  // Public sets: enforce read-only at the mount, and blanket-exec perms (the
  // manifest carries no mode bits; skill helper scripts need +x).
  const roArgs = opts.readonly ? ["--read-only", "--file-perms", "0755"] : [];
  return [
    ...mountArgs,
    "--vfs-cache-mode",
    "full",
    // Flush closed files fast: agent outputs become chips/visible to the org
    // ~1s after close instead of rclone's 5s default. Files written
    // incrementally still upload after write-quiescence.
    "--vfs-write-back",
    "1s",
    // Safety-net TTL if the invalidator isn't running or misses a change; the
    // change-feed-driven vfs/refresh (invalidator.ts) is what makes external
    // writes show up in ~1s.
    "--dir-cache-time",
    "10s",
    ...rcArgs,
    ...roArgs,
  ];
}

export function createRcloneMounter(
  rclonePath: string,
  opts: {
    /** FUSE `--allow-other` (Linux): lets OTHER uids/containers read the
     *  mount — required when a privileged sidecar mounts for an unprivileged
     *  main container (cluster pods). Needs `user_allow_other` in fuse.conf. */
    allowOther?: boolean;
  } = {},
): Mounter {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";
  return {
    async mount({ webdavUrl, mountPath, rcAddr, readonly }) {
      // rclone's nfsmount/mount (and the umount/fusermount detach below) have
      // no Windows equivalent. This is unreachable in practice: MountManager
      // gates on win32 BEFORE ever calling mountOne (see its constructor doc),
      // so `active` stays empty there and this Mounter is never invoked. Throw
      // defensively rather than hand back a fake success handle — a caller
      // that bypassed the manager gate must not get an indistinguishable-from-
      // real MountHandle, since that would let downstream link logic
      // (ensureOrgRepoLink / repointOutputLinkForRun) symlink into an unbacked
      // directory and silently strand files (see entry.ts's link-gate doc).
      if (isWindows) {
        throw new Error("org-fs mounts are not supported on Windows");
      }
      // Reclaim: clear a stale mount from a prior killed session so we don't
      // layer a fresh mount over a hung one (no-op on a clean path). Async so
      // a wedged fusermount/umount can't freeze the daemon's event loop (see
      // detach-mount.ts's detachMountAsync doc).
      await detachMountAsync(mountPath, isMac);

      const args = buildMountArgs({
        isMac,
        mountPath,
        allowOther: opts.allowOther,
        readonly,
        rcAddr,
      });
      const proc = Bun.spawn([rclonePath, ...args], {
        env: {
          ...process.env,
          RCLONE_CONFIG_WD_TYPE: "webdav",
          RCLONE_CONFIG_WD_URL: webdavUrl,
          RCLONE_CONFIG_WD_VENDOR: "other",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
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

/** Cap on how long we wait for rclone to exit after SIGTERM before SIGKILLing.
 *  Well under the pod's terminationGracePeriod so all mounts can drain in
 *  parallel and still leave slack. */
const RCLONE_EXIT_TIMEOUT_MS = 5_000;

function makeHandle(
  proc: { kill: (signal?: number) => void; exited: Promise<number> },
  mountPath: string,
  isMac: boolean,
): MountHandle {
  return {
    // Surfaced so MountManager can watch for an unexpected rclone death and
    // self-heal (reclaim + remount) before the mount goes stale.
    exited: proc.exited,
    async unmount() {
      // Detach the OS mount first, then stop the foreground rclone child.
      await detachMountAsync(mountPath, isMac);
      try {
        proc.kill();
      } catch {
        // already gone
      }
      // rclone flushes its --vfs-cache-mode full write-back cache on SIGTERM;
      // against a slow or unreachable studio that flush can outlast the pod's
      // terminationGracePeriod and hang shutdown → the sidecar is SIGKILLed
      // (exit 137). Bound the wait, then SIGKILL rclone so teardown always
      // makes progress. Unflushed writes at teardown are best-effort anyway.
      const exited = proc.exited.catch(() => {});
      const timeout = Symbol("timeout");
      const outcome = await Promise.race([
        exited.then(() => null),
        sleep(RCLONE_EXIT_TIMEOUT_MS).then(() => timeout),
      ]);
      if (outcome === timeout) {
        try {
          proc.kill(9);
        } catch {
          // already gone
        }
        await exited;
      }
    },
  };
}
