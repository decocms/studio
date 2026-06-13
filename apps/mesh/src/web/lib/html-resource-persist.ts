/**
 * IndexedDB persistence for MCP-app UI-resource HTML queries.
 *
 * UI-resource HTML is large (multi-MiB self-contained bundles), so it must NOT
 * go through the localStorage bootstrap cache (query-persist.ts) — localStorage
 * is ~5 MB and synchronous. This persists ONLY the `ui-resource-html` queries
 * to IndexedDB (async, large quota), so they survive reloads / brief offline:
 * on boot we restore them into the query cache (best-effort warm start), and on
 * every successful read we write the latest HTML back.
 *
 * The GET endpoint already gives the browser HTTP cache (ETag + max-age), so
 * this is the "instant cross-session / offline" layer on top of that.
 */

import type { QueryClient } from "@tanstack/react-query";
import { UI_RESOURCE_HTML_KEY } from "@decocms/mesh-sdk";

const DB_NAME = "mesh-ui-resources";
const STORE = "html";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ENTRIES = 50; // bound the store; prune oldest beyond this on restore
const MAX_VALUE_BYTES = 16 * 1024 * 1024; // mirror the server-side resources/read cap

interface StoredHtml {
  html: string;
  updatedAt: number;
  /** Build version, so a deploy invalidates stale cached HTML. */
  buster: string;
}

function version(): string {
  return typeof __MESH_VERSION__ === "string" ? __MESH_VERSION__ : "dev";
}

function isHtmlResourceKey(key: readonly unknown[]): boolean {
  return key[0] === "mcp" && key[1] === UI_RESOURCE_HTML_KEY;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Restore persisted UI-resource HTML into the query cache before the app reads
 * it (best-effort: IndexedDB is async, so a query that runs first just fetches —
 * which is HTTP-cached anyway). Prunes expired / over-budget / stale-version
 * entries. Safe to call once at startup.
 */
export async function restoreHtmlResourceCache(
  queryClient: QueryClient,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    const store = tx(db, "readonly");
    const keys = (await reqToPromise(store.getAllKeys())) as IDBValidKey[];
    const values = (await reqToPromise(store.getAll())) as StoredHtml[];
    const now = Date.now();
    const ver = version();

    // Pair + sort newest-first so over-budget pruning drops the oldest.
    const entries = keys
      .map((key, i) => ({ key, value: values[i] }))
      .sort((a, b) => (b.value?.updatedAt ?? 0) - (a.value?.updatedAt ?? 0));

    const stale: IDBValidKey[] = [];
    let kept = 0;
    for (const { key, value } of entries) {
      const expired =
        !value ||
        value.buster !== ver ||
        now - value.updatedAt > MAX_AGE_MS ||
        kept >= MAX_ENTRIES;
      if (expired) {
        stale.push(key);
        continue;
      }
      kept++;
      try {
        const queryKey = JSON.parse(String(key)) as unknown[];
        if (queryClient.getQueryData(queryKey) === undefined) {
          // Restore with the original timestamp so an entry older than the
          // query's staleTime revalidates immediately on mount (instant render
          // from IDB + background refresh) instead of being treated as fresh.
          queryClient.setQueryData(queryKey, value.html, {
            updatedAt: value.updatedAt,
          });
        }
      } catch {
        stale.push(key);
      }
    }

    if (stale.length > 0) {
      const wstore = tx(db, "readwrite");
      for (const key of stale) wstore.delete(key);
    }
  } catch {
    // IndexedDB unavailable / blocked / corrupt — non-fatal, fall back to fetch.
  }
}

/**
 * Subscribe to the query cache and write successful UI-resource HTML reads to
 * IndexedDB. Returns the unsubscribe fn.
 */
export function persistHtmlResourceCache(queryClient: QueryClient): () => void {
  if (typeof indexedDB === "undefined") return () => {};
  const dbPromise = openDb().catch(() => null);

  return queryClient.getQueryCache().subscribe((event) => {
    const query = event.query;
    if (!Array.isArray(query.queryKey) || !isHtmlResourceKey(query.queryKey)) {
      return;
    }
    if (query.state.status !== "success") return;
    const html = query.state.data;
    if (typeof html !== "string" || html.length > MAX_VALUE_BYTES) return;

    void dbPromise.then((db) => {
      if (!db) return;
      try {
        tx(db, "readwrite").put(
          {
            html,
            updatedAt: Date.now(),
            buster: version(),
          } satisfies StoredHtml,
          JSON.stringify(query.queryKey),
        );
      } catch {
        // best-effort
      }
    });
  });
}

/** Drop all persisted UI-resource HTML (call on sign-out). */
export function clearHtmlResourceCache(): void {
  if (typeof indexedDB === "undefined") return;
  void openDb()
    .then((db) => tx(db, "readwrite").clear())
    .catch(() => {});
}

/**
 * Drop persisted HTML for a single connection. Call when a connection is
 * updated/deleted so the editing client doesn't restore stale HTML on its next
 * reload (other clients self-heal via the no-cache GET on their next read).
 * Keys are `JSON.stringify(["mcp","ui-resource-html", orgSlug, connectionId, uri])`.
 */
export async function clearHtmlResourceCacheForConnection(
  connectionId: string,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    const keys = (await reqToPromise(
      tx(db, "readonly").getAllKeys(),
    )) as IDBValidKey[];
    const wstore = tx(db, "readwrite");
    for (const key of keys) {
      try {
        const parsed = JSON.parse(String(key)) as unknown[];
        if (parsed[1] === UI_RESOURCE_HTML_KEY && parsed[3] === connectionId) {
          wstore.delete(key);
        }
      } catch {
        // skip unparseable keys
      }
    }
  } catch {
    // non-fatal
  }
}
