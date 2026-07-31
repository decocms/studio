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
 * node_modules TREE. A shared store charges per-operation latency — fatal
 * across ~100k small files, a non-issue for a single large sequential blob.
 * The per-file cost is paid by the local extract, on local disk. Mounting a
 * tree here would be slower than no cache at all.
 *
 * The store is S3, mounted via the mountpoint CSI driver, and the code assumes
 * only two things of it: a path can be read sequentially, and a path can be
 * written sequentially. Notably it does NOT assume rename or utimes, because
 * mountpoint has neither — see `publishRemoteGolden` for what that costs and
 * `pruneRemoteGoldens` for the GC that survives it.
 *
 * Unlike L1 this needs no reflink, so it works on whatever filesystem the pod
 * gets. A POSIX-backed store would also work, and would additionally allow the
 * temp-plus-rename publish this deliberately does without.
 *
 * Dormant without GOLDEN_CACHE_REMOTE: absent → every entry point returns
 * immediately and the boot path is exactly L1-then-install as today.
 */

import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../types";
import {
  GOLDEN_MAX_PER_REPO,
  GOLDEN_TTL_MS,
  lockfileHash,
  repoHash,
} from "./golden-cache";
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

async function resolveRemote(opts: RemoteGoldenOpts): Promise<string | null> {
  if (!remoteEnabled()) return null;
  return remoteGoldenPath({
    remoteRoot: opts.remoteRoot ?? process.env.GOLDEN_CACHE_REMOTE,
    cloneUrl: resolveCloneUrl(opts.config),
    pm: opts.pm,
    lockHash: await lockfileHash(opts.installRoot, opts.pm),
  });
}

type Cmd = [string, string[]];

/**
 * Exit code plus the first stderr line from either side. The message is the
 * whole point: "tar exit 2" alone is unactionable — it took a hand-run of the
 * pipe to learn it meant "Unexpected EOF in archive", i.e. a truncated
 * archive rather than a permissions or disk problem.
 */
interface PipeResult {
  code: number;
  stderr: string;
}

/** Single-quote an argument for a POSIX shell. */
function shQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Stream `producer | consumer` to completion, resolving non-zero if EITHER
 * side fails (that's what `pipefail` buys — without it the pipeline reports
 * only the consumer, so a failed `tar -c` feeding a happy `zstd` would look
 * like a successful publish).
 *
 * An explicit pipe rather than tar's own compressor flags, because those are
 * not portable and fail in DIFFERENT ways per flavor: the daemon's image ships
 * GNU tar, but a host runner on macOS has bsdtar, where `-I` means
 * `--include` (so `-I zstd` silently looks for a file named "zstd") and
 * `--use-compress-program` is rejected on read with "Unrecognized archive
 * format". Both verified. `zstd -dc | tar -xf -` behaves identically
 * everywhere.
 *
 * THE SHELL OWNS THE PIPE, deliberately — one `bash -c`, not two `Bun.spawn`s
 * wired together. Handing the producer's stdout to the consumer as `stdin`
 * looks fd-to-fd but Bun relays it through this process once the stream is
 * large enough, and then the relay's write races the consumer: on Linux it
 * throws EPIPE from inside Bun's pump, asynchronously, where no try/catch here
 * can see it — it killed the whole test file and left publish with no archive.
 * A 1 KB fixture never reached the pipe buffer's edge and passed, so only the
 * ~9 MB case caught it. Earlier this same handoff truncated the stream's tail
 * with BOTH children exiting 0. A shell pipeline has neither failure mode: the
 * kernel moves the bytes, nothing traverses this process, and a multi-GB tree
 * stays off the daemon's single event loop so the health probe keeps answering.
 *
 * Arguments are shell-quoted rather than interpolated: they carry a mount root
 * and an install root from operator config, and a path with a space would
 * otherwise split into two arguments.
 */
async function runPiped(producer: Cmd, consumer: Cmd): Promise<PipeResult> {
  const render = ([bin, args]: Cmd) => [bin, ...args].map(shQuote).join(" ");
  const script = `set -o pipefail; ${render(producer)} | ${render(consumer)}`;
  try {
    const p = Bun.spawn(["bash", "-c", script], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    // stderr is drained concurrently with the transfer — a tool that writes
    // more than a pipe buffer of diagnostics would otherwise block forever
    // waiting for someone to read it.
    const [code, err] = await Promise.all([
      p.exited,
      new Response(p.stderr).text(),
    ]);
    // Keep it short enough for a log line, since a tar failure can repeat
    // per member.
    const why = err.trim().split("\n")[0] ?? "";
    return { code, stderr: why.slice(0, 200) };
  } catch (e) {
    // Only a missing `bash` lands here now — a missing `zstd` or `tar` is
    // bash's own 127 above. Either way it's a miss, so the caller falls back
    // to a normal install.
    return { code: 1, stderr: (e as Error).message };
  }
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
  const archive = await resolveRemote(opts);
  if (!archive) return false;
  if (!(await exists(archive))) return false;

  const target = join(opts.installRoot, "node_modules");
  const staging = join(opts.installRoot, `.node_modules.l2.${process.pid}`);
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    // The archive stores a `node_modules/` prefix, so it lands at
    // <staging>/node_modules.
    const r = await runPiped(
      ["zstd", ["-dc", archive]],
      ["tar", ["-xf", "-", "-C", staging]],
    );
    if (r.code !== 0) {
      log(
        `[golden-l2] restore failed (exit ${r.code}: ${r.stderr}) — falling back`,
      );
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
 * Best-effort and idempotent: no-op if the archive already exists, and the
 * archive is read back before the function reports success, so a truncated
 * write never survives as a permanently-broken key.
 *
 * The write goes straight to the final key — see the note inline. A blob store
 * has no rename, and does not need one.
 */
export async function publishRemoteGolden(
  opts: RemoteGoldenOpts,
): Promise<void> {
  const log = opts.log ?? (() => {});
  try {
    const archive = await resolveRemote(opts);
    if (!archive) return;
    const source = join(opts.installRoot, "node_modules");
    if (!(await exists(source))) return;
    if (await exists(archive)) return; // already published for this lockfile

    // Best-effort: a blob store has no real directories, so creating the
    // prefix is a no-op there and may not be supported at all. Writing the
    // key below is what creates it.
    await mkdir(dirname(archive), { recursive: true }).catch(() => {});
    // Written straight to its final key, NOT to a temp name plus rename.
    // The shared store is a blob store (S3 via mountpoint) and rename does not
    // exist there. Nothing is lost by dropping it: an object becomes visible
    // only once its upload completes, so a publisher killed mid-write leaves
    // no readable object — the same guarantee the rename was providing.
    //
    // Porting this to a POSIX store would need the temp+rename back, because
    // there a partial file IS visible to a concurrent reader.
    const r = await runPiped(
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
      ["zstd", [...ZSTD_ARGS, "-q", "-o", archive]],
    );
    if (r.code !== 0) {
      log(`[golden-l2] publish failed (exit ${r.code}: ${r.stderr})`);
      await rm(archive, { force: true }).catch(() => {});
      return;
    }
    // A bad archive here is PERMANENT: publish no-ops once the key exists, so
    // every node in the fleet would keep failing its restore and paying a full
    // install, with nothing to repair it. Read it back and drop it if it does
    // not parse — publish already runs after the boot is healthy, off the
    // critical path, and this is one sequential pass.
    //
    // Now that the write goes to the live key, this reads back over the
    // network rather than off local disk. That is the cost of losing rename;
    // it buys the same protection, and the alternative — staging the archive
    // in the pod first — would spend the tenant's /app quota on a file that
    // can be several hundred MB.
    const check = await runPiped(
      ["zstd", ["-dc", archive]],
      ["tar", ["-tf", "-"]],
    );
    if (check.code !== 0) {
      log(
        `[golden-l2] publish discarded — archive failed read-back (${check.stderr})`,
      );
      await rm(archive, { force: true }).catch(() => {});
      return;
    }
    log("[golden-l2] published node_modules to shared cache");
    await pruneRemoteGoldens(opts.remoteRoot, { log });
  } catch (e) {
    log(`[golden-l2] publish skipped: ${(e as Error).message}`);
  }
}

/**
 * Bound shared-store growth, same rule as the node-local store
 * (golden-cache.ts `pruneGoldens`): per repo, drop archives untouched for
 * longer than the TTL, then keep only the newest GOLDEN_MAX_PER_REPO. Restore
 * touches an archive's mtime, so a lockfile still booting never ages out.
 *
 * Async throughout — the store is NFS, where a readdir over the whole tree is
 * a network round trip per entry. `pruneGoldens` may use *Sync on local disk;
 * here that would park the daemon's event loop and stall its health probe
 * (CONTRIBUTING rule #1).
 *
 * Opportunistic (after a successful publish) and best-effort, so it only ever
 * runs where publish does — i.e. wherever the store is writable. Racing a
 * concurrent restore is safe: the reader either finished its extract or falls
 * back to install.
 */
export async function pruneRemoteGoldens(
  remoteRoot: string | undefined = process.env.GOLDEN_CACHE_REMOTE,
  opts: {
    ttlMs?: number;
    maxPerRepo?: number;
    now?: number;
    log?: Log;
  } = {},
): Promise<void> {
  if (!remoteRoot) return;
  const ttlMs = opts.ttlMs ?? GOLDEN_TTL_MS;
  const maxPerRepo = opts.maxPerRepo ?? GOLDEN_MAX_PER_REPO;
  const now = opts.now ?? Date.now();
  const root = join(remoteRoot, "golden");
  let repos: string[];
  try {
    repos = await readdir(root);
  } catch {
    return; // nothing published yet
  }
  for (const repo of repos) {
    const repoDir = join(root, repo);
    let entries: { path: string; mtime: number }[];
    try {
      const names = await readdir(repoDir);
      entries = await Promise.all(
        names
          .filter((n) => n.endsWith(".tar.zst")) // skip in-flight `.tmp.<pid>`
          .map(async (n) => {
            const path = join(repoDir, n);
            return { path, mtime: (await stat(path)).mtimeMs };
          }),
      );
    } catch {
      continue;
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      if (i >= maxPerRepo || now - e.mtime > ttlMs) {
        await rm(e.path, { force: true }).catch(() => {});
        opts.log?.(`[golden-l2] pruned ${e.path}`);
      }
    }
  }
}
