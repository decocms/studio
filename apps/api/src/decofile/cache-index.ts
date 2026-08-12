/**
 * Pure LRU/budget arithmetic for the decofile disk cache (see
 * disk-cache-spec.md, "Index & budget"). Plain data in/out — no fs, no env,
 * no I/O — so the unit suite covers it without mocks. The fs shell
 * (`disk-cache.ts`) owns all filesystem effects and supplies the limits via
 * {@link CacheIndexConfig} (env parsing belongs to the shell, not here).
 *
 * Deviations from the spec sketch, all deliberate:
 * - `createIndex` takes a second `config` argument carrying the budgets and
 *   per-area admission caps (the sketch left limits implicit).
 * - `admit` both *plans and applies*: on admission it mutates the index —
 *   drops the evicted entries, replaces any existing entry at the same path,
 *   and inserts the new entry at the MRU end — and returns the list of paths
 *   whose files the shell must delete before writing. This keeps the index
 *   and the plan atomic in one call; the shell never mutates the index for an
 *   admit beyond executing the returned deletions on disk.
 * - Seed entries derive their area from the path prefix (`merged/` →
 *   "merged", anything else → "blobs"), matching the disk layout; a re-admit
 *   of an existing path adopts the area passed to `admit`.
 *
 * Invariants:
 * - `entries` iterates oldest (LRU) → newest (MRU); Map insertion order is
 *   the LRU order, `touch`/`admit` re-insert at the end.
 * - Eviction plans are oldest-first within their constraint set and never
 *   free more than needed beyond entry granularity: the total budget may
 *   evict from both areas, the merged sub-budget evicts only `merged`
 *   entries.
 * - A re-admitted path never appears in its own eviction plan (the write
 *   replaces the file in place).
 * - An index seeded over budget is tolerated; the next `admit` evicts down.
 */

export type CacheArea = "blobs" | "merged";

export interface CacheIndexConfig {
  /** Total byte budget across both areas. */
  maxTotalBytes: number;
  /** Sub-budget for the `merged` area (must be ≤ maxTotalBytes to matter). */
  maxMergedBytes: number;
  /** Per-area admission cap for a single entry; larger entries are refused. */
  maxEntryBytes: Record<CacheArea, number>;
}

export interface CacheEntry {
  bytes: number;
  area: CacheArea;
}

export interface CacheIndex {
  readonly config: CacheIndexConfig;
  /** LRU order: first inserted = oldest = first eviction candidate. */
  readonly entries: Map<string, CacheEntry>;
  totalBytes: number;
  areaBytes: Record<CacheArea, number>;
}

export interface AdmitRequest {
  path: string;
  bytes: number;
  area: CacheArea;
}

export interface AdmitResult {
  admitted: boolean;
  /** Paths whose files the fs shell must delete (already dropped from the index). */
  evict: string[];
}

function areaFromPath(path: string): CacheArea {
  return path.startsWith("merged/") ? "merged" : "blobs";
}

/**
 * Build an index from a startup scan. `mtimeMs` seeds the LRU order (oldest
 * mtime = oldest entry); duplicate paths keep the newest-mtime occurrence.
 */
export function createIndex(
  entries: Array<{ path: string; bytes: number; mtimeMs: number }>,
  config: CacheIndexConfig,
): CacheIndex {
  const byPath = new Map<string, { bytes: number; mtimeMs: number }>();
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (!existing || entry.mtimeMs >= existing.mtimeMs) {
      byPath.set(entry.path, { bytes: entry.bytes, mtimeMs: entry.mtimeMs });
    }
  }
  const sorted = [...byPath.entries()].sort(
    (a, b) => a[1].mtimeMs - b[1].mtimeMs,
  );
  const index: CacheIndex = {
    config,
    entries: new Map(),
    totalBytes: 0,
    areaBytes: { blobs: 0, merged: 0 },
  };
  for (const [path, { bytes }] of sorted) {
    const area = areaFromPath(path);
    index.entries.set(path, { bytes, area });
    index.totalBytes += bytes;
    index.areaBytes[area] += bytes;
  }
  return index;
}

/** Mark an entry as most-recently used. Unknown paths are a no-op. */
export function touch(index: CacheIndex, path: string): void {
  const entry = index.entries.get(path);
  if (!entry) return;
  index.entries.delete(path);
  index.entries.set(path, entry);
}

/** Drop an entry from the index. Unknown paths are a no-op. */
export function remove(index: CacheIndex, path: string): void {
  const entry = index.entries.get(path);
  if (!entry) return;
  index.entries.delete(path);
  index.totalBytes -= entry.bytes;
  index.areaBytes[entry.area] -= entry.bytes;
}

/**
 * Evict-then-write plan. Refuses entries over the per-area admission cap,
 * over the total budget, or (merged) over the merged sub-budget — those can
 * never fit, even after evicting everything. Otherwise computes the
 * oldest-first evictions that make room, applies them and the insertion to
 * the index, and returns the paths to delete on disk.
 */
export function admit(index: CacheIndex, request: AdmitRequest): AdmitResult {
  const { path, bytes, area } = request;
  const { config } = index;
  const refused =
    !Number.isFinite(bytes) ||
    bytes < 0 ||
    bytes > config.maxEntryBytes[area] ||
    bytes > config.maxTotalBytes ||
    (area === "merged" && bytes > config.maxMergedBytes);
  if (refused) return { admitted: false, evict: [] };

  // Re-admit replaces the existing entry: exclude it from current usage.
  const existing = index.entries.get(path);
  let total = index.totalBytes - (existing?.bytes ?? 0);
  let merged =
    index.areaBytes.merged - (existing?.area === "merged" ? existing.bytes : 0);

  const evict: string[] = [];
  const evicted = new Set<string>();

  // Merged sub-budget: only merged entries are candidates.
  if (area === "merged") {
    for (const [candidate, entry] of index.entries) {
      if (merged + bytes <= config.maxMergedBytes) break;
      if (candidate === path || entry.area !== "merged") continue;
      evict.push(candidate);
      evicted.add(candidate);
      merged -= entry.bytes;
      total -= entry.bytes;
    }
  }

  // Total budget: candidates span both areas.
  for (const [candidate, entry] of index.entries) {
    if (total + bytes <= config.maxTotalBytes) break;
    if (candidate === path || evicted.has(candidate)) continue;
    evict.push(candidate);
    evicted.add(candidate);
    total -= entry.bytes;
  }

  for (const candidate of evict) remove(index, candidate);
  remove(index, path); // replace-in-place: drop old bytes, re-insert at MRU
  index.entries.set(path, { bytes, area });
  index.totalBytes += bytes;
  index.areaBytes[area] += bytes;
  return { admitted: true, evict };
}

/**
 * Sanitize an owner/repo path segment per the disk layout rules: lowercase,
 * keep `[a-z0-9._-]`, percent-encode every other byte of the UTF-8 encoding
 * (lowercase hex; `%` itself is always encoded, so output is unambiguous).
 * Dot-only results (`.`, `..`) are fully encoded so no segment can ever be a
 * path traversal token. Empty input is invalid and throws.
 */
export function sanitizeSegment(segment: string): string {
  if (segment === "") {
    throw new TypeError("cache path segment must not be empty");
  }
  const lowered = segment.toLowerCase();
  let out = "";
  for (const byte of new TextEncoder().encode(lowered)) {
    const char = String.fromCharCode(byte);
    out += /[a-z0-9._-]/.test(char)
      ? char
      : `%${byte.toString(16).padStart(2, "0")}`;
  }
  if (out === "." || out === "..") {
    out = out.replaceAll(".", "%2e");
  }
  return out;
}

/** True for exactly-40-char lowercase hex git SHAs. */
export function isValidSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha);
}
