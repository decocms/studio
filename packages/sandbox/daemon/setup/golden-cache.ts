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
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../types";

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
function repoHash(cloneUrl: string): string {
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

/** True when both paths resolve to the same filesystem (reflink prerequisite). */
export function sameFilesystem(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

type Log = (msg: string) => void;

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
  const cacheRoot = opts.cacheRoot ?? process.env.DEPS_CACHE_ROOT;
  const golden = goldenNodeModulesPath({
    cacheRoot,
    cloneUrl: opts.config.git?.repository?.cloneUrl,
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
  log("[golden] restored node_modules from cache (skipped install)");
  return true;
}

/**
 * Snapshot a freshly-installed node_modules as the golden for its lockfile.
 * Best-effort and idempotent: no-op if a golden already exists, atomic
 * publish (reflink to a temp dir, then rename) so a concurrent publisher or a
 * crash mid-copy never leaves a half-written golden in place. Never throws.
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
