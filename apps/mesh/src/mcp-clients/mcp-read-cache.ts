/**
 * MCP Read Cache
 *
 * Per-pod in-memory TTL+LRU cache for read-only MCP content methods that take
 * parameters: `resources/read` and `prompts/get`. The list cache
 * (mcp-list-cache.ts, NATS KV) covers tools/resources/prompts *lists*; this
 * covers the *content* reads those lists point at.
 *
 * Scope: keyed by (connectionId, method, params) only — NOT by principal. This
 * is a deliberate choice (shared across org members) and assumes a connection's
 * read responses are the same for every member. It would leak content between
 * users if an upstream personalizes `resources/read` / `prompts/get` per caller.
 * Invalidated on connection update/delete.
 */

import { meter } from "../observability";

const cacheCounter = meter.createCounter("mcp_read_cache.fetches", {
  description: "MCP read cache fetch outcomes (hit, miss)",
  unit: "{fetches}",
});

/** Long TTL — read content is treated as slow-changing (see module note). */
const READ_CACHE_TTL_MS = 5 * 60_000;
/** LRU cap to bound memory; oldest entries evicted first. */
const READ_CACHE_MAX_ENTRIES = 1000;
/** Skip caching results larger than this (avoid pinning huge file blobs). */
const READ_CACHE_MAX_VALUE_BYTES = 2 * 1024 * 1024; // 2 MiB

export type McpReadType = "resources/read" | "prompts/get";

interface CacheEntry {
  value: unknown;
  expiresAt: number;
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

export class InMemoryMcpReadCache {
  // Map preserves insertion order — first key is the LRU eviction candidate.
  private readonly store = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = READ_CACHE_TTL_MS,
    private readonly maxEntries: number = READ_CACHE_MAX_ENTRIES,
  ) {}

  private key(
    type: McpReadType,
    connectionId: string,
    params: unknown,
  ): string {
    return `${connectionId}:${type}:${stableStringify(params)}`;
  }

  get(
    type: McpReadType,
    connectionId: string,
    params: unknown,
  ): unknown | null {
    const key = this.key(type, connectionId, params);
    const entry = this.store.get(key);
    if (!entry) {
      cacheCounter.add(1, { type, outcome: "miss" });
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      cacheCounter.add(1, { type, outcome: "miss" });
      return null;
    }
    // LRU bump: re-insert to move to the most-recent position.
    this.store.delete(key);
    this.store.set(key, entry);
    cacheCounter.add(1, { type, outcome: "hit" });
    return entry.value;
  }

  set(
    type: McpReadType,
    connectionId: string,
    params: unknown,
    value: unknown,
  ): void {
    // Skip oversized results so a single large resource can't pin memory.
    try {
      if (JSON.stringify(value).length > READ_CACHE_MAX_VALUE_BYTES) return;
    } catch {
      return; // non-serializable — don't cache
    }

    const key = this.key(type, connectionId, params);
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Drop every cached read for a connection (config/auth may have changed). */
  invalidate(connectionId: string): void {
    const prefix = `${connectionId}:`; //
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

// Per-pod singleton — pure in-memory, no external deps, always available.
const readCache = new InMemoryMcpReadCache();

export function getMcpReadCache(): InMemoryMcpReadCache {
  return readCache;
}
