/**
 * Golden node_modules cache — the reflink "last mile" on top of the bun
 * download cache (see depsCacheEnv in install.ts).
 *
 * A fresh sandbox pod has an empty node_modules and pays a full `bun install`
 * (download + materialize). This keeps a per-`(repo, packageManager,
 * lockfile)` "golden" node_modules on the shared node-local hostPath
 * (DEPS_CACHE_ROOT). On a hit we `cp --reflink=always` it into the repo — a
 * CoW clone that's near-instant regardless of tree size (measured ~1s for
 * 700MB on prod xfs) and skips `bun install` entirely. On a miss we run the
 * normal install, then publish its result as the golden for next time.
 *
 * Safety mirrors depsCacheEnv's per-repo key (the only cross-repo isolation
 * boundary — bun does not re-verify cache content): a golden is keyed by the
 * credential-stripped cloneUrl, so repos never share one. Within a repo,
 * sharing is the same trust domain (sandbox access implies repo write).
 * reflink is copy-on-write, so a pod mutating its own node_modules never
 * writes through to the shared golden — verified: writing a cloned file
 * leaves the source intact.
 *
 * Only used when the golden dir and the repo's node_modules live on the same
 * filesystem (reflink requires it — `st_dev` must match). On any other setup
 * (e.g. a hostPath on a different mount than the pod's workdir) golden is
 * skipped and the normal install path runs. Best-effort throughout: any
 * failure falls back to `bun install`, never blocks the boot.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../types";
import { resolveCloneUrl } from "./install";

/**
 * GC bounds for the golden store (a golden ≈ a full node_modules on the node
 * hostPath, so unbounded growth would fill the disk). Pruned opportunistically
 * after each publish: drop goldens untouched for longer than the TTL, then cap
 * the number kept per repo (newest by mtime win). Restore touches a golden's
 * mtime, so an actively-used lockfile never ages out.
 */
export const GOLDEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const GOLDEN_MAX_PER_REPO = 5;

/** Pod-local runtime caches that must not travel in a shared golden. */
const RUNTIME_CACHE_DIRS = [".vite", ".cache"];

/**
 * Lockfiles that fully pin a package manager's resolution, so an identical
 * lockfile yields an identical node_modules. No lockfile → no golden (we
 * can't guarantee the tree is reproducible, so caching it is unsafe).
 */
const LOCKFILES: Record<string, readonly string[]> = {
  bun: ["bun.lock", "bun.lockb"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
};

/** 16 hex chars of sha256, credential-stripped — matches depsCacheEnv's key. */
export function repoHash(cloneUrl: string): string {
  let key = cloneUrl;
  try {
    const u = new URL(cloneUrl);
    u.username = "";
    u.password = "";
    key = u.toString();
  } catch {
    // non-URL cloneUrl (ssh shorthand) — hash it as-is
  }
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Content hash of the first present lockfile for `pm` under `installRoot`.
 * Null when no lockfile exists (→ golden disabled for this install).
 */
export function lockfileHash(installRoot: string, pm: string): string | null {
  const names = LOCKFILES[pm];
  if (!names) return null;
  for (const name of names) {
    const path = join(installRoot, name);
    try {
      const buf = readFileSync(path);
      return createHash("sha256").update(buf).digest("hex").slice(0, 32);
    } catch {
      // not this one — try the next
    }
  }
  return null;
}

/**
 * Absolute golden node_modules path for a `(repo, pm, lockfile)` triple, or
 * null when golden can't apply: no cache root, no cloneUrl, or no lockfile.
 * Pure given the lockHash — the fs read lives in `lockfileHash`.
 */
export function goldenNodeModulesPath(opts: {
  cacheRoot: string | undefined;
  cloneUrl: string | undefined;
  pm: string;
  lockHash: string | null;
}): string | null {
  const { cacheRoot, cloneUrl, pm, lockHash } = opts;
  if (!cacheRoot || !cloneUrl || !lockHash) return null;
  return join(
    cacheRoot,
    "golden",
    repoHash(cloneUrl),
    `${pm}-${lockHash}`,
    "node_modules",
  );
}

/**
 * True when both paths report the same `st_dev` — a cheap NEGATIVE filter for
 * reflink (different dev ⇒ reflink can't work, skip the doomed cp). It is NOT
 * sufficient: two bind-mounts of one underlying fs can share a dev number yet
 * still EXDEV on reflink (observed on kind: /deps-cache hostPath + /app
 * emptyDir both dev fe01, cp --reflink=always fails). The `cp` exit code is
 * the authoritative test; callers must handle its failure regardless.
 */
export function sameFilesystem(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

type Log = (msg: string) => void;

/**
 * Independent kill switch. Golden touches the boot's install path, so it stays
 * OFF unless explicitly enabled — separate from depsCache (which only mounts
 * the cache + biases bun's backend). Ships dormant; flip GOLDEN_CACHE_ENABLED
 * to turn it on, unset to disable without redeploying the daemon image.
 */
export function goldenEnabled(): boolean {
  const v = process.env.GOLDEN_CACHE_ENABLED;
  return v === "1" || v === "true";
}

/** reflink-clone `src` → `dst` via coreutils cp. Resolves to the exit code. */
function reflinkClone(src: string, dst: string): Promise<number> {
  // --reflink=always (not auto): fail loudly rather than silently degrade to a
  // slow full copy that would block the boot — the caller falls back to a
  // normal install on non-zero. -a preserves the tree faithfully. Args array
  // (no shell) keeps paths from being reinterpreted.
  return new Promise((resolve) => {
    const child = spawn("cp", ["-a", "--reflink=always", src, dst], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

interface GoldenOpts {
  config: Config;
  installRoot: string;
  pm: string;
  cacheRoot?: string;
  log?: Log;
}

function resolveGolden(opts: GoldenOpts): {
  golden: string;
  targetNodeModules: string;
} | null {
  if (!goldenEnabled()) return null;
  const cacheRoot = opts.cacheRoot ?? process.env.DEPS_CACHE_ROOT;
  const golden = goldenNodeModulesPath({
    cacheRoot,
    cloneUrl: resolveCloneUrl(opts.config),
    pm: opts.pm,
    lockHash: lockfileHash(opts.installRoot, opts.pm),
  });
  if (!golden) return null;
  return { golden, targetNodeModules: join(opts.installRoot, "node_modules") };
}

/**
 * Reflink an existing golden into the repo's node_modules, skipping install.
 * Returns true only when node_modules is now populated from the golden.
 */
export async function tryRestoreGolden(opts: GoldenOpts): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const paths = resolveGolden(opts);
  if (!paths) return false;
  const { golden, targetNodeModules } = paths;
  if (!existsSync(golden)) return false;
  // reflink needs golden and the destination parent on one filesystem.
  if (!sameFilesystem(golden, opts.installRoot)) {
    log("[golden] cache and workdir on different filesystems — skipping");
    return false;
  }
  try {
    // A partial node_modules (interrupted prior boot) would make cp nest the
    // clone inside it; start clean.
    rmSync(targetNodeModules, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  const code = await reflinkClone(golden, targetNodeModules);
  if (code !== 0) {
    log(`[golden] restore failed (cp exit ${code}) — falling back to install`);
    rmSync(targetNodeModules, { recursive: true, force: true });
    return false;
  }
  // Mark recently-used so GC's TTL doesn't reap an actively-restored lockfile.
  try {
    const now = new Date();
    utimesSync(golden, now, now);
  } catch {
    // best-effort
  }
  log("[golden] restored node_modules from cache (skipped install)");
  return true;
}

/**
 * Snapshot a node_modules as the golden for its lockfile. Publish only ever
 * runs for a boot whose dev server came up healthy (the orchestrator defers
 * it to the `running` transition) — a broken install therefore never becomes
 * a golden, which is what keeps a bad golden from getting stuck and reused.
 *
 * Best-effort and idempotent: no-op if a golden already exists; reflink to a
 * temp dir, strip pod-local runtime caches (.vite/.cache — they churn and are
 * per-pod), then atomically rename so a concurrent publisher or a crash
 * mid-copy never leaves a half-written golden in place. Never throws.
 */
export async function publishGolden(opts: GoldenOpts): Promise<void> {
  const log = opts.log ?? (() => {});
  try {
    const paths = resolveGolden(opts);
    if (!paths) return;
    const { golden, targetNodeModules } = paths;
    if (!existsSync(targetNodeModules)) return;
    if (existsSync(golden)) return; // already published for this lockfile

    const goldenDir = dirname(golden);
    mkdirSync(goldenDir, { recursive: true });
    // Now that goldenDir exists, confirm it shares a filesystem with the
    // source (reflink prerequisite) — skip the doomed cp otherwise. (Checked
    // here, not before mkdir, since statSync on a not-yet-created dir fails.)
    if (!sameFilesystem(opts.installRoot, goldenDir)) {
      log(
        "[golden] cache and workdir on different filesystems — not publishing",
      );
      return;
    }
    // Unique temp within the same dir (→ same fs → atomic rename). PID keeps
    // concurrent publishers on one node from colliding.
    const tmp = join(goldenDir, `.tmp.${process.pid}.node_modules`);
    rmSync(tmp, { recursive: true, force: true });
    const code = await reflinkClone(targetNodeModules, tmp);
    if (code !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      log(`[golden] publish reflink failed (cp exit ${code})`);
      return;
    }
    // Strip pod-local runtime caches from the snapshot (cheap — reflink is
    // CoW, so these were near-free to clone and near-free to drop).
    for (const d of RUNTIME_CACHE_DIRS) {
      rmSync(join(tmp, d), { recursive: true, force: true });
    }
    try {
      renameSync(tmp, golden);
      log("[golden] published node_modules to cache");
    } catch {
      // Lost the race (another publisher renamed first) or golden appeared —
      // both fine; drop our temp.
      rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    log(`[golden] publish skipped: ${(e as Error).message}`);
  }
}

/**
 * Bound golden-store growth on the node. For each repo: drop goldens whose
 * mtime is older than the TTL, then keep only the newest GOLDEN_MAX_PER_REPO.
 * Opportunistic (called after a publish), best-effort, never throws. Safe to
 * race a concurrent restore: an in-flight reflink from a golden we delete just
 * fails → that pod falls back to install, and already-completed CoW clones are
 * independent of the source.
 */
export function pruneGoldens(
  cacheRoot: string | undefined = process.env.DEPS_CACHE_ROOT,
  opts: { ttlMs?: number; maxPerRepo?: number; now?: number } = {},
): void {
  if (!cacheRoot) return;
  const ttlMs = opts.ttlMs ?? GOLDEN_TTL_MS;
  const maxPerRepo = opts.maxPerRepo ?? GOLDEN_MAX_PER_REPO;
  const now = opts.now ?? Date.now();
  const root = join(cacheRoot, "golden");
  let repos: string[];
  try {
    repos = readdirSync(root);
  } catch {
    return; // no golden store yet
  }
  for (const repo of repos) {
    const repoDir = join(root, repo);
    let entries: { path: string; mtime: number }[];
    try {
      entries = readdirSync(repoDir)
        .filter((name) => !name.startsWith(".tmp.")) // skip in-flight publishes
        .map((name) => {
          const path = join(repoDir, name);
          return { path, mtime: statSync(path).mtimeMs };
        });
    } catch {
      continue;
    }
    // Newest first; anything past the cap or older than the TTL is pruned.
    entries.sort((a, b) => b.mtime - a.mtime);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (i >= maxPerRepo || now - e.mtime > ttlMs) {
        rmSync(e.path, { recursive: true, force: true });
      }
    }
  }
}
