/**
 * Filesystem shell for the decofile disk cache (see disk-cache-spec.md).
 *
 * Owns every filesystem effect around the pure LRU/budget core in
 * `cache-index.ts`: lazy init (mkdir + startup scan), atomic
 * stage-in-tmp-then-rename writes, evict-plan execution, the statfs free-space
 * floor, ENOSPC emergency eviction, per-operation scratch dirs, and the
 * reconciliation sweeper. Consumers are `read-decofile.ts` and
 * `commit-coalescer.ts`.
 *
 * Golden rules honored here:
 * - Fail open (rule 4): no operation ever throws — reads degrade to `null`
 *   (a cache miss), writes to a no-op, always with a metric.
 * - Never block the event loop (rule 5): async `node:fs/promises` only.
 * - The disk cannot fill (rule 3): evict-then-write via `admit`, admission
 *   caps, free-space floor, ENOSPC handled with eviction to 50% of budget.
 *
 * Limits come from env (spec §Limits), read lazily at first use. Empty
 * `DECOFILE_CACHE_DIR` is the kill switch: every get returns null, every put
 * no-ops, `makeScratchDir` returns null.
 *
 * Metrics use the module-level OTel `meter` (live binding — instruments are
 * created lazily at first cache init, so they bind the post-SDK-start meter in
 * production). A plain in-process counter mirror is exposed via
 * `decofileCacheStats()` for tests and for chunk 4's log lines.
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sleep } from "@decocms/shared/std";
import type { Counter } from "@opentelemetry/api";
import { meter } from "../observability";
import {
  admit,
  type CacheArea,
  type CacheIndex,
  type CacheIndexConfig,
  createIndex,
  isValidSha,
  remove,
  sanitizeSegment,
  touch,
} from "./cache-index";

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const TMP_ORPHAN_MAX_AGE_MS = 60 * 60_000;

interface DiskCacheConfig {
  enabled: boolean;
  root: string;
  index: CacheIndexConfig;
  freeFloorBytes: number;
  sweepIntervalMs: number;
}

interface CacheState {
  root: string;
  index: CacheIndex;
  cfg: DiskCacheConfig;
}

/** Non-negative integer from env; anything unset/invalid falls to `def`. */
function envBytes(name: string, def: number): number {
  const raw = Bun.env[name];
  if (raw === undefined || raw === "") return def;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : def;
}

let config: DiskCacheConfig | null = null;

function getConfig(): DiskCacheConfig {
  if (config) return config;
  const dirRaw = Bun.env.DECOFILE_CACHE_DIR;
  const root =
    dirRaw === undefined ? join(tmpdir(), "studio-decofile-cache") : dirRaw;
  config = {
    enabled: root !== "",
    root,
    index: {
      maxTotalBytes: envBytes("DECOFILE_CACHE_MAX_BYTES", 2 * GiB),
      maxMergedBytes: envBytes("DECOFILE_CACHE_MERGED_MAX_BYTES", 512 * MiB),
      maxEntryBytes: {
        blobs: envBytes("DECOFILE_CACHE_MAX_BLOB_BYTES", MiB),
        merged: envBytes("DECOFILE_CACHE_MAX_MERGED_BYTES", 32 * MiB),
      },
    },
    freeFloorBytes: envBytes("DECOFILE_CACHE_FREE_FLOOR_BYTES", GiB),
    sweepIntervalMs: envBytes("DECOFILE_CACHE_SWEEP_INTERVAL_MS", 10 * 60_000),
  };
  return config;
}

/** True unless the `DECOFILE_CACHE_DIR=""` kill switch is set. */
export function decofileCacheEnabled(): boolean {
  return getConfig().enabled;
}

// ---------------------------------------------------------------------------
// Observability: OTel instruments (spec names) + a plain mirror for tests.

interface Instruments {
  hits: Counter;
  misses: Counter;
  evictions: Counter;
  errors: Counter;
  floorSkips: Counter;
}

let instruments: Instruments | null = null;

function zeroCounters() {
  return {
    hits: { blobs: 0, merged: 0 } as Record<CacheArea, number>,
    misses: { blobs: 0, merged: 0 } as Record<CacheArea, number>,
    evictions: 0,
    errors: 0,
    floorSkips: 0,
    invalidKeySkips: 0,
    admissionRefusals: 0,
  };
}

let counters = zeroCounters();

/** Instruments are per-process (never re-registered on test reset); their
 * gauge callbacks read `currentState`, which resets do clear. */
function ensureInstruments(): void {
  if (instruments) return;
  instruments = {
    hits: meter.createCounter("decofile_cache_hits", {
      description: "Decofile disk cache hits by area",
      unit: "{reads}",
    }),
    misses: meter.createCounter("decofile_cache_misses", {
      description: "Decofile disk cache misses by area",
      unit: "{reads}",
    }),
    evictions: meter.createCounter("decofile_cache_evictions", {
      description: "Decofile disk cache entries evicted",
      unit: "{entries}",
    }),
    errors: meter.createCounter("decofile_cache_errors", {
      description: "Decofile disk cache swallowed errors by operation",
      unit: "{errors}",
    }),
    floorSkips: meter.createCounter("decofile_cache_floor_skips", {
      description: "Decofile disk cache writes skipped by the free-space floor",
      unit: "{writes}",
    }),
  };
  meter
    .createObservableGauge("decofile_cache_bytes", {
      description: "Decofile disk cache bytes by area",
      unit: "By",
    })
    .addCallback((result) => {
      if (!currentState) return;
      result.observe(currentState.index.areaBytes.blobs, { area: "blobs" });
      result.observe(currentState.index.areaBytes.merged, { area: "merged" });
    });
  meter
    .createObservableGauge("decofile_cache_entries", {
      description: "Decofile disk cache entry count by area",
      unit: "{entries}",
    })
    .addCallback((result) => {
      if (!currentState) return;
      const count: Record<CacheArea, number> = { blobs: 0, merged: 0 };
      for (const entry of currentState.index.entries.values()) {
        count[entry.area] += 1;
      }
      result.observe(count.blobs, { area: "blobs" });
      result.observe(count.merged, { area: "merged" });
    });
}

function countHit(area: CacheArea): void {
  counters.hits[area] += 1;
  instruments?.hits.add(1, { area });
}

function countMiss(area: CacheArea): void {
  counters.misses[area] += 1;
  instruments?.misses.add(1, { area });
}

function countEviction(): void {
  counters.evictions += 1;
  instruments?.evictions.add(1);
}

function countError(op: string): void {
  counters.errors += 1;
  instruments?.errors.add(1, { op });
}

function countInvalidKey(op: string): void {
  counters.invalidKeySkips += 1;
  instruments?.errors.add(1, { op: `${op}_invalid_key` });
}

/**
 * In-process snapshot of the cache's counters and index totals. Read by the
 * unit tests and available to chunk 4 for log lines; the OTel instruments
 * above are the primary observability surface.
 */
export function decofileCacheStats() {
  return {
    enabled: getConfig().enabled,
    totalBytes: currentState?.index.totalBytes ?? 0,
    areaBytes: {
      blobs: currentState?.index.areaBytes.blobs ?? 0,
      merged: currentState?.index.areaBytes.merged ?? 0,
    },
    entryCount: currentState?.index.entries.size ?? 0,
    hits: { ...counters.hits },
    misses: { ...counters.misses },
    evictions: counters.evictions,
    errors: counters.errors,
    floorSkips: counters.floorSkips,
    invalidKeySkips: counters.invalidKeySkips,
    admissionRefusals: counters.admissionRefusals,
  };
}

// ---------------------------------------------------------------------------
// State: lazy, single-flighted init.

let statePromise: Promise<CacheState | null> | null = null;
let currentState: CacheState | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepJitterAbort: AbortController | null = null;

/** Init is single-flighted by caching the promise: concurrent first
 * operations all await the same mkdir + scan. Never rejects. */
function getState(): Promise<CacheState | null> {
  statePromise ??= init();
  return statePromise;
}

async function init(): Promise<CacheState | null> {
  const cfg = getConfig();
  if (!cfg.enabled) return null;
  ensureInstruments();
  try {
    await mkdir(join(cfg.root, "blobs"), { recursive: true });
    await mkdir(join(cfg.root, "merged"), { recursive: true });
    await mkdir(join(cfg.root, "tmp"), { recursive: true });
  } catch {
    // Can't create the layout: run with the cache off until restart (fail
    // open — callers see misses/no-ops, requests still succeed).
    countError("init");
    return null;
  }
  let seed: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
  try {
    seed = await scanCacheDir(cfg.root);
  } catch {
    countError("scan");
    seed = [];
  }
  const state: CacheState = {
    root: cfg.root,
    index: createIndex(seed, cfg.index),
    cfg,
  };
  currentState = state;
  startSweeper(state);
  return state;
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** One recursive scan of the fixed-depth layout
 * (`<area>/<owner>/<repo>/<file>`); mtimes seed the LRU order. Files that
 * vanish mid-scan (races) are skipped. */
async function scanCacheDir(
  root: string,
): Promise<Array<{ path: string; bytes: number; mtimeMs: number }>> {
  const out: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
  for (const area of ["blobs", "merged"] as const) {
    const areaDir = join(root, area);
    for (const owner of await readdirSafe(areaDir)) {
      const ownerDir = join(areaDir, owner);
      for (const repo of await readdirSafe(ownerDir)) {
        const repoDir = join(ownerDir, repo);
        for (const file of await readdirSafe(repoDir)) {
          try {
            const info = await stat(join(repoDir, file));
            if (!info.isFile()) continue;
            out.push({
              path: `${area}/${owner}/${repo}/${file}`,
              bytes: info.size,
              mtimeMs: info.mtimeMs,
            });
          } catch {
            // raced with eviction/cleanup — skip
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keys.

function blobKey(owner: string, repo: string, blobSha: string): string | null {
  if (!isValidSha(blobSha)) return null;
  try {
    return `blobs/${sanitizeSegment(owner)}/${sanitizeSegment(repo)}/${blobSha}`;
  } catch {
    return null; // empty segment
  }
}

function mergedKey(
  owner: string,
  repo: string,
  headSha: string,
): string | null {
  if (!isValidSha(headSha)) return null;
  try {
    return `merged/${sanitizeSegment(owner)}/${sanitizeSegment(repo)}/${headSha}.json`;
  } catch {
    return null; // empty segment
  }
}

// ---------------------------------------------------------------------------
// Reads.

async function readEntry(
  area: CacheArea,
  rel: string | null,
): Promise<string | null> {
  try {
    const state = await getState();
    if (!state) return null;
    if (rel === null) {
      countMiss(area);
      return null;
    }
    try {
      const content = await readFile(join(state.root, rel), "utf8");
      touch(state.index, rel);
      countHit(area);
      return content;
    } catch {
      // ENOENT (raced an eviction) or any read error: a miss, never a failure.
      countMiss(area);
      return null;
    }
  } catch {
    countError(`get_${area}`);
    return null;
  }
}

export function getBlob(
  owner: string,
  repo: string,
  blobSha: string,
): Promise<string | null> {
  return readEntry("blobs", blobKey(owner, repo, blobSha));
}

export function getMerged(
  owner: string,
  repo: string,
  headSha: string,
): Promise<string | null> {
  return readEntry("merged", mergedKey(owner, repo, headSha));
}

// ---------------------------------------------------------------------------
// Writes.

/** Free-space floor: skip writes when the volume is under external pressure.
 * A statfs failure (unsupported fs) does not block writes — the floor is a
 * safeguard, not a gate. */
async function hasFreeSpace(state: CacheState): Promise<boolean> {
  if (state.cfg.freeFloorBytes <= 0) return true;
  try {
    const fsInfo = await statfs(state.root);
    return fsInfo.bavail * fsInfo.bsize >= state.cfg.freeFloorBytes;
  } catch {
    return true;
  }
}

async function unlinkSafe(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ENOENT (already gone) or transient error — the sweeper reconciles.
  }
}

/** ENOSPC response: evict oldest entries until usage is below 50% of the
 * total budget, deleting their files. */
async function emergencyEvict(state: CacheState): Promise<void> {
  try {
    const target = state.cfg.index.maxTotalBytes / 2;
    while (state.index.totalBytes > target) {
      const oldest = state.index.entries.keys().next();
      if (oldest.done) break;
      remove(state.index, oldest.value);
      await unlinkSafe(join(state.root, oldest.value));
      countEviction();
    }
  } catch {
    countError("emergency_evict");
  }
}

async function writeEntry(
  area: CacheArea,
  op: string,
  rel: string | null,
  content: string,
): Promise<void> {
  try {
    const state = await getState();
    if (!state) return;
    if (rel === null) {
      countInvalidKey(op);
      return;
    }
    if (!(await hasFreeSpace(state))) {
      counters.floorSkips += 1;
      instruments?.floorSkips.add(1);
      return;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    const plan = admit(state.index, { path: rel, bytes, area });
    if (!plan.admitted) {
      // Over an admission cap — served but not cached (spec §Limits). Not an
      // OTel metric (not in the spec's list); tracked for tests/logs only.
      counters.admissionRefusals += 1;
      return;
    }
    for (const victim of plan.evict) {
      await unlinkSafe(join(state.root, victim));
      countEviction();
    }
    // Atomic write: stage in tmp/ on the same volume, then rename into place.
    const staging = join(state.root, "tmp", `stage-${randomUUID()}`);
    try {
      await writeFile(staging, content, "utf8");
      const dest = join(state.root, rel);
      await mkdir(dirname(dest), { recursive: true });
      await rename(staging, dest);
    } catch (err) {
      // The admit already inserted the entry; the file never landed. Undo.
      remove(state.index, rel);
      await unlinkSafe(staging);
      countError(op);
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOSPC") {
        await emergencyEvict(state);
      }
    }
  } catch {
    countError(op);
  }
}

export function putBlob(
  owner: string,
  repo: string,
  blobSha: string,
  content: string,
): Promise<void> {
  return writeEntry(
    "blobs",
    "put_blob",
    blobKey(owner, repo, blobSha),
    content,
  );
}

export function putMerged(
  owner: string,
  repo: string,
  headSha: string,
  content: string,
): Promise<void> {
  return writeEntry(
    "merged",
    "put_merged",
    mergedKey(owner, repo, headSha),
    content,
  );
}

// ---------------------------------------------------------------------------
// Scratch dirs (tar extraction, staging) under `<root>/tmp/`.

export async function makeScratchDir(): Promise<string | null> {
  try {
    const state = await getState();
    if (!state) return null;
    const dir = join(state.root, "tmp", randomUUID());
    await mkdir(dir, { recursive: true });
    return dir;
  } catch {
    countError("make_scratch");
    return null;
  }
}

export async function removeScratchDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    countError("remove_scratch");
  }
}

// ---------------------------------------------------------------------------
// Sweeper: reconciliation backstop (write-time eviction is the primary
// control). Jittered first run, then one unref'd setInterval.

function startSweeper(state: CacheState): void {
  const interval = state.cfg.sweepIntervalMs;
  if (interval <= 0) return;
  sweepJitterAbort = new AbortController();
  sleep(Math.random() * interval, { signal: sweepJitterAbort.signal })
    .then(() => {
      void sweep(state);
      const timer = setInterval(() => void sweep(state), interval);
      timer.unref?.();
      sweepTimer = timer;
    })
    .catch(() => {
      // aborted by the test reset hook — sweeper never starts
    });
}

async function sweep(state: CacheState): Promise<void> {
  try {
    // Reconcile index vs disk: rescan (drift from external deletes, crashed
    // writes, other tooling), then enforce budgets on the rebuilt index.
    const rebuilt = createIndex(
      await scanCacheDir(state.root),
      state.cfg.index,
    );
    const limits = state.cfg.index;
    for (const [path, entry] of rebuilt.entries) {
      const overTotal = rebuilt.totalBytes > limits.maxTotalBytes;
      const overMerged = rebuilt.areaBytes.merged > limits.maxMergedBytes;
      if (!overTotal && !overMerged) break;
      if (!overTotal && overMerged && entry.area !== "merged") continue;
      remove(rebuilt, path);
      await unlinkSafe(join(state.root, path));
      countEviction();
    }
    state.index = rebuilt;

    // Remove tmp/ orphans older than 1h (crashed extractions/writes).
    const tmpRoot = join(state.root, "tmp");
    const now = Date.now();
    for (const name of await readdirSafe(tmpRoot)) {
      const path = join(tmpRoot, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > TMP_ORPHAN_MAX_AGE_MS) {
          await rm(path, { recursive: true, force: true });
        }
      } catch {
        // raced — skip
      }
    }
  } catch {
    countError("sweep");
  }
}

// ---------------------------------------------------------------------------
// Test hooks.

/**
 * FOR TESTS ONLY. Runs one sweep immediately (the timer-driven schedule is
 * untestable without waiting out the interval).
 */
export async function sweepDecofileCacheForTests(): Promise<void> {
  const state = await getState();
  if (state) await sweep(state);
}

/**
 * FOR TESTS ONLY. Resets every module singleton (config, state, sweeper
 * timers, counters) so each test re-reads `Bun.env` from scratch. OTel
 * instruments stay registered (per-process); their gauge callbacks read the
 * reset state.
 */
export function resetDecofileDiskCacheForTests(): void {
  sweepJitterAbort?.abort();
  sweepJitterAbort = null;
  if (sweepTimer !== null) clearInterval(sweepTimer);
  sweepTimer = null;
  statePromise = null;
  currentState = null;
  config = null;
  counters = zeroCounters();
}
