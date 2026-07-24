/**
 * MCP Read Cache (stale-while-revalidate)
 *
 * Per-pod TTL+LRU cache for the results of READ-ONLY MCP methods that take
 * parameters: `tools/call` (read-only tools), `resources/read`, `prompts/get`.
 * The list cache (mcp-list-cache, NATS KV) covers tool/resource/prompt *lists*;
 * this covers the per-call *results* those lists point at.
 *
 * Semantics: stale-while-revalidate. A hit returns immediately; once older than
 * the type's `revalidateAfterMs`, a single-flight background revalidation
 * refreshes it (a stampede of concurrent callers triggers at most one upstream
 * call). Past `maxStaleMs` a hit is treated as a miss and the caller blocks on a
 * live fetch.
 *
 * Scope (two tiers):
 *  - "org" (default): the key omits the principal, so the result is shared
 *    across every org member. This assumes the result does NOT depend on the
 *    caller — only valid for upstreams that ignore the per-user identity
 *    (Studio's token header, including its legacy alias).
 *  - "user": the key includes the principal, so a result is never shared across
 *    users. Safe for any read-only operation.
 *
 * Caller invariants (lazy-client): only read-only operations reach here; tool
 * error results (`isError`) are never stored (via `shouldCache`); the
 * org-ownership check precedes this cache. Per-pod, so a connection change
 * invalidates it across replicas via a NATS broadcast (mcp-cache-invalidation);
 * TTL is the worst-case floor if a broadcast is lost.
 */

import { meter } from "../observability";
import { getSettings } from "../settings";

const cacheCounter = meter.createCounter("mcp_read_cache.fetches", {
  description: "MCP read cache outcomes (hit, stale, miss, error)",
  unit: "{fetches}",
});

export type McpReadType = "tools/call" | "resources/read" | "prompts/get";

/** Cache scope: org-shared (default) or isolated per principal. */
export type ReadCacheScope = { kind: "org" } | { kind: "user"; userId: string };

interface TypeConfig {
  /** Serve a hit immediately; revalidate in the background past this age. */
  revalidateAfterMs: number;
  /** Past this age a hit is a miss — block on a live fetch instead of serving. */
  maxStaleMs: number;
  /** Skip caching results larger than this (avoid pinning huge payloads). */
  maxValueBytes: number;
}

const KiB = 1024 as const;
const MiB = KiB * KiB;

/** Per-method tuning. Content reads are slow-changing and can be large; tool
 * results change faster, so refresh sooner and cap their size tighter. */
const DEFAULT_READ_CACHE_CONFIG: Record<McpReadType, TypeConfig> = {
  "tools/call": {
    revalidateAfterMs: 30_000,
    maxStaleMs: 5 * 60_000,
    maxValueBytes: 512 * KiB,
  },
  "resources/read": {
    revalidateAfterMs: 60_000,
    maxStaleMs: 5 * 60_000,
    maxValueBytes: 4 * MiB,
  },
  "prompts/get": {
    revalidateAfterMs: 60_000,
    maxStaleMs: 5 * 60_000,
    maxValueBytes: 512 * KiB,
  },
};

const READ_CACHE_MAX_ENTRIES = 2000;
// Hard ceiling on aggregate cached bytes (per pod). With multi-MiB entries the
// entry-count cap alone isn't enough — evict LRU until under this too, so the
// cache can't grow into the heap-pressure territory that OOM'd pods before.
const READ_CACHE_MAX_TOTAL_BYTES = 256 * MiB;

// Opt-in tracing: `MCP_CACHE_DEBUG=1` logs every fetch outcome + store skip so
// we can see hit/miss/stale and oversize rejections live. Temporary diagnostic.
const DEBUG = typeof process !== "undefined" && !!process.env?.MCP_CACHE_DEBUG;
function debug(...args: unknown[]): void {
  if (DEBUG) console.log("[mcp-read-cache]", ...args);
}

function scopeKey(scope: ReadCacheScope): string {
  return scope.kind === "org" ? "org" : `u:${scope.userId}`;
}

/** Deterministic stringify (sorted keys) so equivalent params hash identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify(
          (value as Record<string, unknown>)[k],
        )}`,
    )
    .join(",")}}`;
}

interface CacheEntry {
  value: unknown;
  storedAt: number;
  bytes: number;
}

export class InMemoryMcpReadCache {
  // Map preserves insertion order — first key is the LRU eviction candidate.
  private readonly store = new Map<string, CacheEntry>();
  // Keys with an in-flight background revalidation (single-flight guard).
  private readonly revalidating = new Set<string>();
  // Running sum of cached entry bytes, kept in lockstep with the store.
  private totalBytes = 0;

  constructor(
    private readonly config: Record<
      McpReadType,
      TypeConfig
    > = DEFAULT_READ_CACHE_CONFIG,
    private readonly maxEntries: number = READ_CACHE_MAX_ENTRIES,
    // Injectable clock for deterministic tests; defaults to wall time.
    private readonly now: () => number = () => Date.now(),
    private readonly maxTotalBytes: number = READ_CACHE_MAX_TOTAL_BYTES,
  ) {}

  /** Current size snapshot for observability (cheap O(1) reads). */
  stats(): { entries: number; bytes: number } {
    return { entries: this.store.size, bytes: this.totalBytes };
  }

  /** Delete a key and keep the byte accounting in sync. */
  private deleteKey(key: string): void {
    const e = this.store.get(key);
    if (e) {
      this.store.delete(key);
      this.totalBytes -= e.bytes;
    }
  }

  private key(
    type: McpReadType,
    connectionId: string,
    scope: ReadCacheScope,
    params: unknown,
  ): string {
    return `${connectionId}:${scopeKey(scope)}:${type}:${stableStringify(
      params,
    )}`;
  }

  private storeSet(
    key: string,
    value: unknown,
    now: number,
    maxValueBytes: number,
  ): void {
    // Skip oversized results so a single large payload can't pin memory.
    let bytes: number;
    try {
      bytes = JSON.stringify(value).length;
    } catch {
      debug("SKIP non-serializable", key);
      return; // non-serializable — don't cache
    }
    if (bytes > maxValueBytes) {
      debug("SKIP oversize", key, `${bytes}b > cap ${maxValueBytes}b`);
      return;
    }
    // Drop any existing entry's bytes before re-inserting.
    this.deleteKey(key);
    // Evict LRU (oldest-first) until there's room by BOTH count and bytes.
    while (
      this.store.size > 0 &&
      (this.store.size >= this.maxEntries ||
        this.totalBytes + bytes > this.maxTotalBytes)
    ) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.deleteKey(oldest);
    }
    this.store.set(key, { value, storedAt: now, bytes });
    this.totalBytes += bytes;
  }

  /**
   * Stale-while-revalidate fetch for a read-only MCP method result.
   *
   * @param fetchLive Performs the live upstream call. MUST reject (not return)
   *   on error.
   * @param shouldCache Decide whether a freshly fetched value may be stored.
   *   Returning false still returns the value but skips the cache — used to keep
   *   `isError` tool results out of the cache. Defaults to caching everything.
   * @param onRevalidation Receives the background revalidation promise so the
   *   request lifecycle can await it (e.g. `ctx.pendingRevalidations`).
   */
  async fetch(params: {
    type: McpReadType;
    connectionId: string;
    scope: ReadCacheScope;
    params: unknown;
    fetchLive: () => Promise<unknown>;
    shouldCache?: (value: unknown) => boolean;
    onRevalidation?: (promise: Promise<void>) => void;
  }): Promise<unknown> {
    const {
      type,
      connectionId,
      scope,
      params: callParams,
      fetchLive,
      shouldCache,
      onRevalidation,
    } = params;
    const cfg = this.config[type];
    const key = this.key(type, connectionId, scope, callParams);
    const now = this.now();
    const entry = this.store.get(key);
    const age = entry ? now - entry.storedAt : Infinity;

    // Miss, or stale past the hard limit: block on a live fetch.
    if (!entry || age > cfg.maxStaleMs) {
      cacheCounter.add(1, { type, outcome: "miss" });
      debug(entry ? "EXPIRED" : "MISS", key);
      const value = await fetchLive();
      if (shouldCache?.(value) ?? true) {
        this.storeSet(key, value, this.now(), cfg.maxValueBytes);
      } else {
        debug("NOT-CACHED (shouldCache=false)", key);
      }
      return value;
    }

    // LRU bump.
    this.store.delete(key);
    this.store.set(key, entry);

    if (age > cfg.revalidateAfterMs && !this.revalidating.has(key)) {
      cacheCounter.add(1, { type, outcome: "stale" });
      debug("STALE → serve + revalidate", key, `age=${age}ms`);
      this.revalidating.add(key);
      const revalidation = fetchLive()
        .then((value) => {
          if (shouldCache?.(value) ?? true) {
            this.storeSet(key, value, this.now(), cfg.maxValueBytes);
          }
        })
        .catch(() => {
          // Best-effort: keep serving the existing entry until maxStaleMs.
          cacheCounter.add(1, { type, outcome: "error" });
        })
        .finally(() => this.revalidating.delete(key));
      onRevalidation?.(revalidation);
    } else {
      cacheCounter.add(1, { type, outcome: "hit" });
      debug("HIT", key, `age=${age}ms`);
    }

    return entry.value;
  }

  /** Drop every cached result for a connection (config/auth may have changed). */
  invalidate(connectionId: string): void {
    const prefix = `${connectionId}:`;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.deleteKey(key);
    }
  }
}

// Per-pod singleton — pure in-memory, no external deps.
const readCache = new InMemoryMcpReadCache();

// Cache-size gauges (sampled at collection time). The cache OOM'd pods before,
// so its live entry count and byte footprint are the signals a Grafana
// dashboard charts against the READ_CACHE_MAX_ENTRIES / _TOTAL_BYTES caps.
meter
  .createObservableGauge("mcp_read_cache.entries", {
    description: "Current entry count in the per-pod MCP read cache",
    unit: "{entries}",
  })
  .addCallback((r) => r.observe(readCache.stats().entries));
meter
  .createObservableGauge("mcp_read_cache.bytes", {
    description: "Approximate total bytes held in the per-pod MCP read cache",
    unit: "By",
  })
  .addCallback((r) => r.observe(readCache.stats().bytes));

/**
 * MCP read/list caching. On by default in production, off in development;
 * MCP_CACHE_ENABLED overrides either way (resolved in settings). Same flag
 * gates the cross-pod NATS KV list cache.
 */
export function isMcpCacheEnabled(): boolean {
  return getSettings().mcpCacheEnabled;
}

/** The per-pod read cache, or null when MCP caching is disabled. */
export function getMcpReadCache(): InMemoryMcpReadCache | null {
  return isMcpCacheEnabled() ? readCache : null;
}
