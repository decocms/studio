/**
 * Org-fs sidecar runtime (cluster pods).
 *
 * Hosted sandboxes can't mount in the main container (locked-down
 * securityContext), so a privileged sidecar does it: this loop waits for the
 * daemon to relay the mount config onto the shared control volume (see
 * routes/orgfs-config.ts — the config arrives post-bind, after this container
 * is already running), mounts the volumes with the SAME MountManager the
 * desktop daemon uses (FUSE + --allow-other), and lets Bidirectional mount
 * propagation surface them in the unprivileged main container.
 *
 * After mounting it writes a status file so the daemon (a different
 * container) can tell the mounts are live — e.g. the per-run output link
 * gates on it. Pods are single-claim (warm Sandboxes are adopted once and
 * die with the claim), so the config is consumed once; later writes are
 * ignored.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sleep } from "@decocms/shared/std";
import { type OrgFsMountConfig, parseOrgFsConfig } from "./config";

/** The MountManager surface the sidecar drives (structural, for tests). */
export interface SidecarMountManager {
  start(config: OrgFsMountConfig, appRoot: string): Promise<void>;
  stop(): Promise<void>;
  list(): { volume: string; mountPath: string }[];
}

export interface SidecarOpts {
  /** Config file the daemon relays ORGFS_CONFIG into (shared volume). */
  configPath: string;
  /** Status file this writes once mounted (read by the daemon container). */
  statusPath: string;
  appRoot: string;
  /** Real: MountManager over createRcloneMounter(..., { allowOther: true }). */
  manager: SidecarMountManager;
  signal: AbortSignal;
  /** Config poll interval; default 1s. */
  pollMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

/** Mirrors `MountManager.list()`; the daemon reads this from the status file. */
export interface SidecarStatus {
  mounts: { volume: string; mountPath: string }[];
}

function writeJsonAtomic(path: string, value: unknown): void {
  // Local control volume, NOT a mount — sync fs is safe here. Atomic so the
  // daemon never reads a torn status file.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.status-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** Run until `signal` aborts: wait for config, mount, report, then unmount. */
export async function runSidecar(opts: SidecarOpts): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  const log = opts.log ?? (() => {});

  let mounted = false;
  while (!opts.signal.aborted && !mounted) {
    const raw = await readFile(opts.configPath, "utf8").catch(() => null);
    const config = raw === null ? null : parseOrgFsConfig(raw);
    if (!config) {
      if (raw !== null) log("invalid org-fs config file; waiting for rewrite");
      await sleep(pollMs, { signal: opts.signal }).catch(() => {});
      continue;
    }
    await opts.manager.start(config, opts.appRoot); // never throws
    try {
      writeJsonAtomic(opts.statusPath, {
        mounts: opts.manager.list(),
      } satisfies SidecarStatus);
    } catch (err) {
      log("status write failed", err);
    }
    log(
      `mounted ${opts.manager.list().length}/${config.mounts.length} volumes`,
    );
    mounted = true;
  }

  if (!opts.signal.aborted) {
    await new Promise<void>((resolve) => {
      opts.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  await opts.manager.stop();
}
