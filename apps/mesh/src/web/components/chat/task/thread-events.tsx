/**
 * ThreadEventsBridge — single SSE → cache patcher for thread-list queries
 * and ThreadConnection.refresh() trigger. Mount once near the app root
 * (inside ProjectContext + QueryClientProvider).
 *
 * Contract:
 *   • thread-list rows are surgically patched via setQueriesData
 *     (no invalidations — refetch storms eliminated by design).
 *   • The matching ThreadConnection (if any) is asked to refresh() on
 *     onFinish + onTaskStatus(in_progress). The conn re-fetches the
 *     server snapshot itself; no React Query intermediary. refresh()
 *     no-ops while a local submit POST is in flight, so the optimistic
 *     local patch isn't briefly overwritten by stale server state.
 */
import { useProjectContext } from "@decocms/mesh-sdk";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";
import { KEYS } from "../../../lib/query-keys";
import { getActiveConn } from "../store/thread-connection";
import type { RowPatch, Task, TasksQueryData, ThreadScope } from "./types";

export type { RowPatch } from "./types";

/**
 * Recover the scope a `KEYS.threads(locator, scope)` cache entry was created
 * with by parsing the query key shape:
 *   ["threads", locator, "org"]
 *   ["threads", locator, "agent", virtualMcpId]
 * Returns null for any other shape (e.g. `threadsInfinite`, `threadMessages`)
 * so iterators can skip unrelated caches that happen to share the prefix.
 */
export function getThreadScopeFromKey(
  key: readonly unknown[],
): ThreadScope | null {
  if (key[2] === "org") return "org";
  if (key[2] === "agent" && typeof key[3] === "string") {
    return { kind: "agent", virtualMcpId: key[3] };
  }
  return null;
}

/**
 * Whether a row with the given `virtual_mcp_id` belongs in a cache of this
 * scope. Org scope shows all threads; agent scope only accepts rows tagged
 * with the matching agent. Rows whose `virtual_mcp_id` is unknown are
 * rejected from agent scopes — the next refetch will repopulate them
 * correctly if they do belong.
 */
export function scopeAcceptsRow(
  scope: ThreadScope,
  virtualMcpId: string | undefined,
): boolean {
  if (scope === "org") return true;
  return virtualMcpId === scope.virtualMcpId;
}

export function applyPatch(
  data: TasksQueryData | undefined,
  patch: RowPatch,
  options: { canInsert?: boolean } = {},
): TasksQueryData | undefined {
  if (!data) return data;

  // Walk every loaded page; the first one containing the row wins.
  let updatedPageIdx = -1;
  let updatedItems: Task[] | null = null;
  for (let i = 0; i < data.pages.length; i++) {
    const page = data.pages[i];
    if (!page) continue;
    const idx = page.items.findIndex((t) => t.id === patch.id);
    if (idx === -1) continue;
    const current = page.items[idx];
    if (!current) continue;
    const next: Task = { ...current, ...patch };
    updatedItems = [...page.items];
    updatedItems[idx] = next;
    updatedPageIdx = i;
    break;
  }

  if (updatedPageIdx !== -1 && updatedItems) {
    const pages = data.pages.map((p, i) =>
      i === updatedPageIdx && updatedItems ? { ...p, items: updatedItems } : p,
    );
    return { ...data, pages };
  }

  // Thread not in any page yet (created in another tab, or never loaded).
  // Insert at the top of the first page with a minimal synthetic row.
  if (options.canInsert === false) return data;
  const now = patch.updated_at ?? new Date().toISOString();
  const synthetic: Task = {
    created_at: now,
    updated_at: now,
    ...patch,
    title: patch.title ?? "New chat",
    branch: patch.branch ?? null,
  };
  const firstPage = data.pages[0];
  if (!firstPage) {
    return {
      ...data,
      pages: [{ items: [synthetic], hasMore: false }],
      pageParams: data.pageParams.length === 0 ? [0] : data.pageParams,
    };
  }
  const pages = [
    { ...firstPage, items: [synthetic, ...firstPage.items] },
    ...data.pages.slice(1),
  ];
  return { ...data, pages };
}

/**
 * Patch every matching thread-list cache for `locator`. Updates of existing
 * rows always apply; insertion of a missing row only happens in caches whose
 * scope accepts a row tagged with `patch.virtual_mcp_id`, so an event for
 * agent A can't pollute agent B's list cache.
 */
export function patchThreadCaches(
  queryClient: QueryClient,
  locator: string,
  patch: RowPatch,
): void {
  const entries = queryClient.getQueriesData<TasksQueryData>({
    queryKey: KEYS.threadsPrefix(locator),
  });
  for (const [key, data] of entries) {
    if (!data) continue;
    const scope = getThreadScopeFromKey(key);
    if (!scope) continue;
    const canInsert = scopeAcceptsRow(scope, patch.virtual_mcp_id);
    const next = applyPatch(data, patch, { canInsert });
    if (next !== data) queryClient.setQueryData(key, next);
  }
}

/**
 * Remove a row from every matching thread-list cache for `locator`.
 * Used by archive/hide flows where the row leaves the "open" view.
 */
export function removeRowFromThreadCaches(
  queryClient: QueryClient,
  locator: string,
  id: string,
): void {
  const entries = queryClient.getQueriesData<TasksQueryData>({
    queryKey: KEYS.threadsPrefix(locator),
  });
  for (const [key, data] of entries) {
    if (!data) continue;
    let mutated = false;
    const pages = data.pages.map((page) => {
      const idx = page.items.findIndex((t) => t.id === id);
      if (idx === -1) return page;
      const items = [...page.items];
      items.splice(idx, 1);
      mutated = true;
      return { ...page, items };
    });
    if (mutated) queryClient.setQueryData(key, { ...data, pages });
  }
}

export type ThreadCacheSnapshots = ReadonlyArray<
  [readonly unknown[], TasksQueryData | undefined]
>;

/** Snapshot every thread-list cache entry for `locator` so an optimistic
 *  mutation can be rolled back per-key on error. */
export function snapshotThreadCaches(
  queryClient: QueryClient,
  locator: string,
): ThreadCacheSnapshots {
  return queryClient.getQueriesData<TasksQueryData>({
    queryKey: KEYS.threadsPrefix(locator),
  });
}

/** Restore the exact snapshots captured by `snapshotThreadCaches`. */
export function rollbackThreadCaches(
  queryClient: QueryClient,
  snapshots: ThreadCacheSnapshots,
): void {
  for (const [key, data] of snapshots) queryClient.setQueryData(key, data);
}

/**
 * Prepend a known row to every matching thread-list cache for `locator`,
 * skipping caches whose scope wouldn't naturally contain a row with this
 * `virtual_mcp_id`. Used by create paths that already have the full row
 * (so we don't need the synthetic-insert flow from `applyPatch`).
 */
export function prependRowToThreadCaches(
  queryClient: QueryClient,
  locator: string,
  row: Task,
): void {
  const entries = queryClient.getQueriesData<TasksQueryData>({
    queryKey: KEYS.threadsPrefix(locator),
  });
  for (const [key, cached] of entries) {
    if (!cached) continue;
    const scope = getThreadScopeFromKey(key);
    if (!scope) continue;
    if (!scopeAcceptsRow(scope, row.virtual_mcp_id)) continue;
    if (cached.pages.some((p) => p.items.some((t) => t.id === row.id))) {
      continue;
    }
    const firstPage = cached.pages[0];
    if (!firstPage) {
      queryClient.setQueryData(key, {
        ...cached,
        pages: [{ items: [row], hasMore: false }],
        pageParams: cached.pageParams.length === 0 ? [0] : cached.pageParams,
      });
      continue;
    }
    const pages = [
      { ...firstPage, items: [row, ...firstPage.items] },
      ...cached.pages.slice(1),
    ];
    queryClient.setQueryData(key, { ...cached, pages });
  }
}

export function ThreadEventsBridge(): null {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();

  const patchAllScopes = (patch: RowPatch) => {
    patchThreadCaches(queryClient, locator, patch);
  };

  useDecopilotEvents({
    orgSlug: org.slug,
    enabled: true,
    onTaskStatus: (event) => {
      patchAllScopes({
        id: event.subject,
        status: event.data.status,
        updated_at: event.time,
        ...(event.data.created_by !== undefined && {
          created_by: event.data.created_by,
        }),
        ...("trigger_id" in event.data && {
          trigger_id: event.data.trigger_id,
        }),
        ...(event.data.virtual_mcp_id !== undefined && {
          virtual_mcp_id: event.data.virtual_mcp_id,
        }),
      });

      // Refresh the active thread's snapshot when its run starts.
      // getActiveConn returns null for inactive threads — they'll fetch
      // fresh on next mount.
      if (event.data.status === "in_progress") {
        void getActiveConn(org.slug, event.subject)?.refresh();
      }
    },
    onFinish: (event) => {
      void getActiveConn(org.slug, event.subject)?.refresh();
    },
  });

  return null;
}
