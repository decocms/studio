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

// Query-key heads that gate first paint on refresh. Keep this list tight —
// persisting org-scoped data widens what lands in localStorage.
const PERSISTED_KEY_HEADS = new Set([
  "publicConfig",
  "activeOrganization",
  "organizations",
]);

let cacheRestored = false;

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

/** Wipe the persisted cache. Call on sign-out so the next user starts clean. */
export function clearPersistedQueryCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Whether this page load hydrated any query from localStorage. */
export function wasCacheRestored(): boolean {
  return cacheRestored;
}
