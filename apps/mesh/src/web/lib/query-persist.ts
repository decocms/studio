/**
 * Lightweight localStorage persistence for the bootstrap React Query cache.
 *
 * On a hard refresh the in-memory cache is gone, so the `useSuspenseQuery`
 * calls that gate first paint (public config, active org) refetch cold and the
 * SplashScreen shows. Hydrating those few queries from localStorage *before*
 * React mounts lets the suspense queries resolve synchronously — no spinner,
 * with a background revalidation per their staleTime.
 *
 * Only the bootstrap queries are persisted; everything else stays in-memory.
 * Implemented on `dehydrate`/`hydrate` from @tanstack/react-query so it needs
 * no extra dependency.
 */

import { type QueryClient, dehydrate, hydrate } from "@tanstack/react-query";

const STORAGE_KEY = "mesh:rq-cache";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const WRITE_DEBOUNCE_MS = 1000;

// Only the public config is persisted. It's the outermost suspense gate
// (theme/styling) and is identical for every user, so caching it is pure win.
//
// Auth-sensitive queries are deliberately NOT persisted: `activeOrganization`
// is an authorization gate (a stale "you're a member" value would render the
// org shell instead of the invite / no-access screen — see shell-layout.tsx),
// and session state must always revalidate against the server.
const PERSISTED_KEY_HEADS = new Set(["publicConfig"]);

let cacheRestored = false;
let orgCacheRestored = false;

function isPersistable(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  return typeof head === "string" && PERSISTED_KEY_HEADS.has(head);
}

/**
 * Synchronously load the persisted bootstrap queries into `queryClient`.
 * Call once at module init, before React renders, so suspense queries find
 * their data in cache. Drops the cache on version bump or expiry.
 */
export function hydrateQueryClient(queryClient: QueryClient): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw) as {
      buster?: string;
      timestamp?: number;
      state?: Parameters<typeof hydrate>[1];
    };

    const stale =
      !parsed.timestamp || Date.now() - parsed.timestamp > MAX_AGE_MS;
    if (parsed.buster !== __MESH_VERSION__ || stale || !parsed.state) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }

    hydrate(queryClient, parsed.state);
    cacheRestored = true;
  } catch {
    // Corrupt entry — drop it, never let it block boot.
    clearPersistedQueryCache();
  }
}

/**
 * Subscribe to cache changes and debounce-write the persistable queries to
 * localStorage. Returns the unsubscribe fn.
 */
export function persistQueryClient(queryClient: QueryClient): () => void {
  if (typeof window === "undefined") return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = () => {
    timer = null;
    try {
      const state = dehydrate(queryClient, {
        shouldDehydrateQuery: (query) =>
          query.state.status === "success" && isPersistable(query.queryKey),
      });
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          buster: __MESH_VERSION__,
          timestamp: Date.now(),
          state,
        }),
      );
    } catch {
      // Quota / serialization failure is non-fatal.
    }
  };

  return queryClient.getQueryCache().subscribe(() => {
    if (timer != null) return;
    timer = setTimeout(write, WRITE_DEBOUNCE_MS);
  });
}

// --- Active-org cache (user-scoped) -----------------------------------------
// Org membership is auth-sensitive, so unlike publicConfig it is NOT persisted
// through the generic dehydrate path. Instead it's keyed by the authenticated
// user id and only ever read back for that same user. A different principal —
// e.g. after a cookie-only logout that leaves localStorage intact — gets a
// cache miss and falls through to a fresh fetch + the access gate. Consumed via
// `initialData` so the suspense query renders instantly and revalidates in the
// background.

const ORG_KEY_PREFIX = "studio:org-cache:";

type CachedOrgMap = Record<string, { data: unknown; updatedAt: number }>;

function orgCacheKey(userId: string): string {
  return `${ORG_KEY_PREFIX}${userId}`;
}

/** Read the cached org for (user, slug), or null on miss/expiry. */
export function readCachedOrg(
  userId: string,
  slug: string,
): { data: unknown; updatedAt: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(orgCacheKey(userId));
    if (!raw) return null;
    const entry = (JSON.parse(raw) as CachedOrgMap)[slug];
    if (!entry || Date.now() - entry.updatedAt > MAX_AGE_MS) return null;
    orgCacheRestored = true;
    return entry;
  } catch {
    return null;
  }
}

/** Store the org for (user, slug). */
export function writeCachedOrg(
  userId: string,
  slug: string,
  data: unknown,
): void {
  if (typeof window === "undefined") return;
  try {
    const key = orgCacheKey(userId);
    const raw = window.localStorage.getItem(key);
    const map: CachedOrgMap = raw ? JSON.parse(raw) : {};
    map[slug] = { data, updatedAt: Date.now() };
    window.localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // Quota / serialization failure is non-fatal.
  }
}

/** Wipe all persisted caches. Call on sign-out so the next user starts clean. */
export function clearPersistedQueryCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(ORG_KEY_PREFIX)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // ignore
  }
}

/** Whether this page load hydrated the public config from localStorage. */
export function wasCacheRestored(): boolean {
  return cacheRestored;
}

/** Whether the active org was served from the user-scoped cache this load. */
export function wasOrgCacheRestored(): boolean {
  return orgCacheRestored;
}
