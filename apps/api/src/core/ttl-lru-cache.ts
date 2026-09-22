/**
 * The TTL+LRU eviction policy shared by every per-org cache in this
 * directory (plan state, org notices, archived status): refresh moves an
 * entry to the most-recently-set position so a hot org isn't the first thing
 * evicted; eviction drops expired entries first, then trims oldest-first
 * once still over `maxSize` (Map iteration order = insertion order).
 */

export function refreshTtlCacheEntry<K, V>(
  cache: Map<K, { value: V; at: number }>,
  key: K,
  value: V,
): void {
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
}

export function evictExpiredTtlCacheEntries<K, V>(
  cache: Map<K, { value: V; at: number }>,
  maxSize: number,
  ttlMs: number,
): void {
  if (cache.size <= maxSize) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= ttlMs) cache.delete(key);
  }
  if (cache.size > maxSize) {
    const excess = cache.size - maxSize;
    let removed = 0;
    for (const key of cache.keys()) {
      if (removed >= excess) break;
      cache.delete(key);
      removed++;
    }
  }
}
