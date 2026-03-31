/**
 * In-memory LRU cache for member role lookups.
 *
 * The `member.role` query runs on every authenticated request. This cache
 * avoids hitting PostgreSQL on every request by keeping recent lookups in
 * memory with a TTL.
 *
 * Invalidation happens explicitly when roles are mutated (add / remove /
 * update-role) and the TTL acts as a safety net for any mutation path we
 * might miss (e.g. direct Better Auth API calls from the web client).
 */

export interface MemberRoleCache {
  get(userId: string, organizationId: string): string | undefined;
  set(userId: string, organizationId: string, role: string): void;
  /** Invalidate a specific user+org entry */
  invalidate(userId: string, organizationId: string): void;
  /** Invalidate all entries for an organization (e.g. bulk role changes) */
  invalidateOrg(organizationId: string): void;
}

interface CacheEntry {
  role: string;
  expiresAt: number;
  organizationId: string;
}

function cacheKey(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}

export function createMemberRoleCache(options?: {
  ttlMs?: number;
  maxSize?: number;
}): MemberRoleCache {
  const ttlMs = options?.ttlMs ?? 2 * 60 * 1000; // 2 minutes
  const maxSize = options?.maxSize ?? 10_000;
  const cache = new Map<string, CacheEntry>();

  function evictExpired() {
    if (cache.size <= maxSize) return;
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) {
        cache.delete(key);
      }
    }
    // If still over limit, remove oldest entries (Map iteration order = insertion order)
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

  return {
    get(userId, organizationId) {
      const key = cacheKey(userId, organizationId);
      const entry = cache.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return undefined;
      }
      return entry.role;
    },

    set(userId, organizationId, role) {
      const key = cacheKey(userId, organizationId);
      cache.set(key, {
        role,
        expiresAt: Date.now() + ttlMs,
        organizationId,
      });
      evictExpired();
    },

    invalidate(userId, organizationId) {
      cache.delete(cacheKey(userId, organizationId));
    },

    invalidateOrg(organizationId) {
      for (const [key, entry] of cache) {
        if (entry.organizationId === organizationId) {
          cache.delete(key);
        }
      }
    },
  };
}
