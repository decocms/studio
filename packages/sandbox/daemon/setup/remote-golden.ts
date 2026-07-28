/**
 * L2: the cross-node golden tier.
 *
 * The node-local golden (golden-cache.ts) only hits when the pod lands on a
 * node already warm for its repo. With the sandbox pool churning ~170 nodes a
 * day across three AZs, a large share of boots land somewhere cold and pay a
 * full install. This tier removes the same-node dependency: a per-`(repo, pm,
 * lockfile)` archive on a shared volume, restorable on ANY node in ANY zone.
 *
 * ONE HARD RULE: a compressed ARCHIVE on the shared store, never the
 * node_modules TREE. The shared store is EFS/NFS, which charges per-operation
 * metadata latency — fatal across ~100k small files, a non-issue for a single
 * large sequential blob. The per-file cost is paid by the local extract, on
 * local disk. Mounting a tree here would be slower than no cache at all.
 *
 * Filesystem-agnostic by design: unlike L1 this needs no reflink, so it works
 * wherever the archive can be read. Nothing below is EFS-specific — the store
 * is just a path, so swapping the backend (S3, a different mount) touches no
 * code here.
 *
 * Dormant without GOLDEN_CACHE_REMOTE: absent → every entry point returns
 * immediately and the boot path is exactly L1-then-install as today.
 */

import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../types";
import { lockfileHash, repoHash } from "./golden-cache";
import { resolveCloneUrl } from "./install";

/**
 * zstd level for publish. -3 is the speed/ratio knee: measured on a 2.3 GB /
 * 168k-file tree it produced 450 MB in 26s, where -19 spent 85s to reach
 * 332 MB. Publish is off the critical path but not free, and restore-side
 * decompression is ~1.6s either way — so the extra 59s buys nothing that
 * matters. -T0 uses all available cores.
 */
const ZSTD_ARGS = ["-3", "-T0"];

/** Pod-local runtime caches that must not travel in a shared archive. */
const RUNTIME_CACHE_DIRS = [".vite", ".cache"];

type Log = (msg: string) => void;

export interface RemoteGoldenOpts {
  config: Config;
  installRoot: string;
  pm: string;
  remoteRoot?: string;
  log?: Log;
}

/**
 * Independent kill switch, separate from GOLDEN_CACHE_ENABLED: L2 adds a
 * shared store to the boot path and must be enableable (and revocable)
 * without touching L1. Unset → today's behavior, no redeploy needed.
 */
function remoteEnabled(): boolean {
  return !!process.env.GOLDEN_CACHE_REMOTE;
}

/**
 * Absolute archive path for a `(repo, pm, lockfile)` triple, or null when L2
 * can't apply. Deliberately keyed identically to the L1 golden — same
 * credential-stripped repo hash, same lockfile hash — so the two tiers can
 * never disagree about what a given key means, and the per-repo isolation
 * boundary is the same one L1 already relies on (bun does not re-verify cache
 * content, so repos must never share).
 */
export function remoteGoldenPath(opts: {
  remoteRoot: string | undefined;
  cloneUrl: string | undefined;
  pm: string;
  lockHash: string | null;
}): string | null {
  const { remoteRoot, cloneUrl, pm, lockHash } = opts;
  if (!remoteRoot || !cloneUrl || !lockHash) return null;
  return join(
    remoteRoot,
    "golden",
    repoHash(cloneUrl),
    `${pm}-${lockHash}.tar.zst`,
  );
}

function resolveRemote(opts: RemoteGoldenOpts): string | null {
  if (!remoteEnabled()) return null;
  return remoteGoldenPath({
    remoteRoot: opts.remoteRoot ?? process.env.GOLDEN_CACHE_REMOTE,
    cloneUrl: resolveCloneUrl(opts.config),
    pm: opts.pm,
    lockHash: lockfileHash(opts.installRoot, opts.pm),
  });
}

type Cmd = [string, string[]];

/**
 * Stream `producer | consumer` to completion, resolving to the first non-zero
 * exit (0 only when both succeed).
 *
 * An explicit pipe rather than tar's own compressor flags, because those are
 * not portable and fail in DIFFERENT ways per flavor: the daemon's image ships
 * GNU tar, but a host runner on macOS has bsdtar, where `-I` means
 * `--include` (so `-I zstd` silently looks for a file named "zstd") and
 * `--use-compress-program` is rejected on read with "Unrecognized archive
 * format". Both verified. `zstd -dc | tar -xf -` behaves identically
 * everywhere.
 *
 * Spawned and streamed, never *Sync and never buffered here: this is the boot
 * path, the daemon is a single-threaded event loop, and a 2 GB tree passing
 * through it would stop the health probe answering — which Studio reads as a
 * dead sandbox and tears down.
 */
function runPiped(producer: Cmd, consumer: Cmd): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(producer[0], producer[1], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const c = spawn(consumer[0], consumer[1], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    let pCode: number | null = null;
    let cCode: number | null = null;
    const settle = () => {
      if (pCode === null || cCode === null) return;
      resolve(pCode !== 0 ? pCode : cCode);
    };
    // If the consumer dies first the producer's writes raise EPIPE; swallow it
    // so an expected teardown can't crash the daemon on an unhandled 'error'.
    c.stdin.on("error", () => {});
    p.stdout.on("error", () => {});
    p.stdout.pipe(c.stdin);
    p.on("error", () => {
      pCode = 1;
      c.stdin.end();
      settle();
    });
    c.on("error", () => {
      cCode = 1;
      settle();
    });
    p.on("close", (code) => {
      pCode = code ?? 1;
      settle();
    });
    c.on("close", (code) => {
      cCode = code ?? 1;
      settle();
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the shared archive into the repo's node_modules, skipping install.
 * Returns true only when node_modules is now populated from the archive.
 *
 * Extraction lands in a staging dir first, then renames into place. A tar
 * interrupted halfway (pod killed, archive truncated) would otherwise leave a
 * partial node_modules that later code reads as a complete one — the boot
 * would skip install and fail later, somewhere unrelated.
 */
export async function tryRestoreRemoteGolden(
  opts: RemoteGoldenOpts,
): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const archive = resolveRemote(opts);
  if (!archive) return false;
  if (!(await exists(archive))) return false;

  const target = join(opts.installRoot, "node_modules");
  const staging = join(opts.installRoot, `.node_modules.l2.${process.pid}`);
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    // The archive stores a `node_modules/` prefix, so it lands at
    // <staging>/node_modules.
    const code = await runPiped(
      ["zstd", ["-dc", archive]],
      ["tar", ["-xf", "-", "-C", staging]],
    );
    if (code !== 0) {
      log(`[golden-l2] restore failed (tar exit ${code}) — falling back`);
      await rm(staging, { recursive: true, force: true });
      return false;
    }
    // A partial tree from an interrupted earlier boot would make the rename
    // land inside it rather than replacing it.
    await rm(target, { recursive: true, force: true });
    await rename(join(staging, "node_modules"), target);
    await rm(staging, { recursive: true, force: true });
  } catch (e) {
    log(`[golden-l2] restore skipped: ${(e as Error).message}`);
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    return false;
  }

  // Mark recently used so a TTL sweep doesn't reap an actively-restored
  // lockfile out from under the repos still booting on it.
  await utimes(archive, new Date(), new Date()).catch(() => {});
  log("[golden-l2] restored node_modules from shared cache (skipped install)");
  return true;
}

/**
 * Publish a node_modules as the shared archive for its lockfile.
 *
 * Callers must only invoke this for a boot whose dev server came up healthy —
 * same rule as L1, and it matters more here: a broken install published to the
 * shared store would poison every node in the fleet, not just this one.
 *
 * Best-effort and idempotent: no-op if the archive already exists; write to a
 * temp path then atomically rename, so a concurrent publisher on another node
 * or a crash mid-write never leaves a truncated archive that a later restore
 * would treat as valid.
 */
export async function publishRemoteGolden(
  opts: RemoteGoldenOpts,
): Promise<void> {
  const log = opts.log ?? (() => {});
  try {
    const archive = resolveRemote(opts);
    if (!archive) return;
    const source = join(opts.installRoot, "node_modules");
    if (!(await exists(source))) return;
    if (await exists(archive)) return; // already published for this lockfile

    await mkdir(dirname(archive), { recursive: true });
    // PID keeps concurrent publishers from different nodes off each other's
    // temp file; the rename below is what makes the result atomic.
    const tmp = `${archive}.tmp.${process.pid}`;
    const code = await runPiped(
      [
        "tar",
        [
          "-cf",
          "-",
          "-C",
          opts.installRoot,
          // Pod-local caches churn per-boot and would bloat every download.
          ...RUNTIME_CACHE_DIRS.map((d) => `--exclude=node_modules/${d}`),
          "node_modules",
        ],
      ],
      ["zstd", [...ZSTD_ARGS, "-q", "-o", tmp]],
    );
    if (code !== 0) {
      log(`[golden-l2] publish failed (tar exit ${code})`);
      await rm(tmp, { force: true }).catch(() => {});
      return;
    }
    try {
      await rename(tmp, archive);
      log("[golden-l2] published node_modules to shared cache");
    } catch {
      // Lost the race to another node — its archive is equally valid for this
      // key, so drop ours.
      await rm(tmp, { force: true }).catch(() => {});
    }
  } catch (e) {
    log(`[golden-l2] publish skipped: ${(e as Error).message}`);
  }
}
