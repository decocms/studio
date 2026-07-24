/**
 * Generic in-memory TTL + LRU cache.
 *
 * Map iteration order is insertion order, so eviction of the "oldest" entry is
 * just removing the first key.
 *
 * By default reads do NOT promote entries — this is a TTL-first cache with a
 * size cap as a memory guard, which suits workloads where TTL (not recency) is
 * the dominant eviction signal. Set `updateRecencyOnGet` for read-heavy caches
 * that want a true access-ordered LRU (a read moves the entry to the newest
 * position so popular keys survive eviction). TTL is never extended on read.
 *
 * Pure logic, no I/O — safe to unit test directly.
 */

export interface TtlLruCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
  size(): number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function createTtlLruCache<T>(options?: {
  ttlMs?: number;
  maxSize?: number;
  /** Promote entries to most-recently-used on read (true access-ordered LRU). */
  updateRecencyOnGet?: boolean;
}): TtlLruCache<T> {
  const ttlMs = options?.ttlMs ?? 60_000;
  const maxSize = options?.maxSize ?? 10_000;
  const updateRecencyOnGet = options?.updateRecencyOnGet ?? false;
  const cache = new Map<string, Entry<T>>();

  function evict() {
    if (cache.size <= maxSize) return;
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    // Still over the cap after dropping expired entries: shed oldest-inserted.
    while (cache.size > maxSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return undefined;
      }
      if (updateRecencyOnGet) {
        // Move to newest position, preserving the original expiry.
        cache.delete(key);
        cache.set(key, entry);
      }
      return entry.value;
    },

    set(key, value) {
      // Delete-then-set so re-inserted keys move to the newest position,
      // keeping insertion order aligned with recency on writes.
      cache.delete(key);
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      evict();
    },

    delete(key) {
      cache.delete(key);
    },

    clear() {
      cache.clear();
    },

    size() {
      return cache.size;
    },
  };
}
