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
import { clearHtmlResourceCache } from "./html-resource-persist";
import { clearRestoreState } from "./last-location";

const STORAGE_KEY = "studio:rq-cache";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const WRITE_DEBOUNCE_MS = 1000;

// Bootstrap queries that gate the home's first paint are persisted so a hard
// refresh hydrates them from localStorage and the suspense reads resolve
// synchronously (no spinner), revalidating in the background per their
// staleTime. All of these are org-scoped, non-secret data:
//   - publicConfig          theme/styling — identical for every user
//   - ai-provider-keys      AI_PROVIDER_KEY_LIST — metadata only, never secrets
//   - organization-settings ORGANIZATION_SETTINGS_GET — sidebar/plugins/config
//   - home-next-actions     the home grid's tiles + prompt chips. Plain (non-
//                           suspense) query with staleTime 0, so without
//                           hydration HomeGrid shows PromptChipsRowSkeleton and
//                           the board reflows once it lands — the reload flicker.
//                           Hydrated, it renders the prior grid instantly and
//                           revalidates in the background.
// plus the VIRTUAL_MCP collection reads (the home's displayed agent), matched
// by key shape below.
//
// Auth-sensitive queries are deliberately NOT persisted: `activeOrganization`
// is an authorization gate (a stale "you're a member" value would render the
// org shell instead of the invite / no-access screen — see shell-layout.tsx),
// and session state must always revalidate against the server.
const PERSISTED_KEY_HEADS = new Set([
  "publicConfig",
  "ai-provider-keys",
  "organization-settings",
  "home-next-actions",
]);

// Collection reads are keyed by `[client, orgId, scopeKey, "collection",
// collectionName, ...]` — the leading `client` serializes to a stable
// `mcp-client:<org>:<conn>` string via its `toJSON` (use-mcp-client.ts), so the
// hash survives reloads and the entry is safe to persist. Limited to the
// collections the home bootstrap reads: VIRTUAL_MCP (sidebar agents + displayed
// agent) and CONNECTIONS (the composer's connection list — the one home-gating
// suspense read that was previously cold on every reload, so the home blanked
// until COLLECTION_CONNECTIONS_LIST returned). Both are org-scoped, non-secret
// metadata (credentials live in the vault, never in the connection list).
const PERSISTED_COLLECTIONS = new Set(["VIRTUAL_MCP", "CONNECTIONS"]);

let cacheRestored = false;
let orgCacheRestored = false;

function isPersistable(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  if (typeof head === "string" && PERSISTED_KEY_HEADS.has(head)) return true;
  return (
    queryKey[3] === "collection" &&
    typeof queryKey[4] === "string" &&
    PERSISTED_COLLECTIONS.has(queryKey[4])
  );
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
    if (parsed.buster !== __STUDIO_VERSION__ || stale || !parsed.state) {
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
          buster: __STUDIO_VERSION__,
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
  // Drop the IndexedDB UI-resource HTML store too (org-scoped UI shells).
  clearHtmlResourceCache();
  if (typeof window === "undefined") return;
  // Where the user last was is theirs, not the browser's — leaving it behind
  // redirects the next account into an org it can't access.
  clearRestoreState();
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
