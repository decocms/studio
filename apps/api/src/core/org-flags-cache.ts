/**
 * Per-organization cache of the `organization_settings.flags` bag.
 *
 * A flag read is a primary-key select, which is cheap until it lands on a path
 * that runs per keystroke: the decofile autosave resolves
 * `commits_authored_by_editor` on every PATCH. Same policy and same bounds as
 * the other per-org caches here (`org-notice-gate`, `plan-feature-gate`).
 *
 * `ORGANIZATION_SETTINGS_UPDATE` drops its own instance's entry, so a toggle
 * lands at once on the pod that served it; the TTL is the worst case for the
 * others, as it is for org notices.
 */

import type { StudioContext } from "./studio-context";
import {
  evictExpiredTtlCacheEntries,
  refreshTtlCacheEntry,
} from "./ttl-lru-cache";

export type OrgFlags = Record<string, unknown> | null;
type OrgFlagsCacheEntry = { value: OrgFlags; at: number };

const ORG_FLAGS_CACHE_TTL_MS = 60_000;
// Cap: entries are only ever overwritten on their own next lookup.
const ORG_FLAGS_CACHE_MAX_SIZE = 10_000;

const orgFlagsCache = new Map<string, OrgFlagsCacheEntry>();

/** Write (or refresh) a cache entry. Exported for unit testing. */
export function refreshOrgFlagsCacheEntry(
  cache: Map<string, OrgFlagsCacheEntry>,
  organizationId: string,
  flags: OrgFlags,
): void {
  refreshTtlCacheEntry(cache, organizationId, flags);
}

/** Exported for unit testing. */
export function evictExpiredOrgFlagsEntries(
  cache: Map<string, OrgFlagsCacheEntry>,
  maxSize: number,
  ttlMs: number,
): void {
  evictExpiredTtlCacheEntries(cache, maxSize, ttlMs);
}

/** Drop one org's flags, so a settings write lands on this instance now. */
export function invalidateOrgFlagsCache(organizationId: string): void {
  orgFlagsCache.delete(organizationId);
}

/**
 * The org's flag bag, from cache when fresh. A failed read answers `null` —
 * every flag then reads as unset, which is how an org with no settings row
 * reads too.
 */
export async function orgFlagsCached(
  ctx: StudioContext,
  organizationId: string,
): Promise<OrgFlags> {
  const hit = orgFlagsCache.get(organizationId);
  if (hit && Date.now() - hit.at < ORG_FLAGS_CACHE_TTL_MS) return hit.value;
  const settings = await ctx.storage.organizationSettings
    .get(organizationId)
    .catch(() => null);
  const flags = settings?.flags ?? null;
  refreshOrgFlagsCacheEntry(orgFlagsCache, organizationId, flags);
  evictExpiredOrgFlagsEntries(
    orgFlagsCache,
    ORG_FLAGS_CACHE_MAX_SIZE,
    ORG_FLAGS_CACHE_TTL_MS,
  );
  return flags;
}
