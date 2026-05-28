# Sidebar: per-group pagination (replace global infinite scroll)

Date: 2026-05-28
Status: Design — pending review

## Problem

The tasks sidebar currently uses a single offset-based infinite-scroll over the flat `COLLECTION_THREADS_LIST` query. The user can group the resulting flat list two ways: by agent (`virtual_mcp_id`) or by status. Both grouping modes fight the pagination:

- A "page" of 50 globally-recent tasks spreads thinly across 100+ agents, leaving most agent groups with 1–3 tasks even though they may have hundreds.
- Status grouping mode has the same problem — the `completed` bucket could have thousands of tasks; loading them through the global feed is wasteful and noisy.
- "Load more" extends the global feed, but the user almost always wants more tasks *for one specific group*, not "next 50 across everything."

This design replaces global infinite scroll with **per-group "show more"**: each agent or status group has its own paginated cursor, fetched on demand. The in-memory model stays a single flat list; pagination state is per-group UI state.

## Goals

- Fast first paint: small initial fetch (10 tasks).
- Each grouping mode (agent / status) gets natural per-group pagination.
- Preserve today's SSE-driven live updates: new tasks created on another tab/device still appear without a refetch.
- Minimal change to the data layer. The `ThreadManagerStore` keeps its current shape and SSE behavior; only the sidebar UI and a single new store method change.

## Non-goals

- No status-based agent tiering. Earlier discussion considered surfacing "agents with attention-needing tasks" at the top; we are dropping that. Recentness is the only ordering axis.
- No new MCP tool. `COLLECTION_THREADS_LIST` already supports the per-group queries needed.
- No change to the per-task SSE stream model (`ActiveThreadStore`, `thread-connection.ts`, etc.).
- No global infinite scroll replacement. The only way to load more tasks is via a group's "Show more" button.

## Architecture

### Stores

- **`ThreadManagerStore`** (existing) — single source of truth for tasks. Holds the flat `threads: Task[]` array sorted by `updated_at` desc, fed by the initial fetch + SSE patches. **Adds one new method:**

  ```ts
  mergeThreads(items: Task[]): void {
    this.threads.update(list =>
      items.reduce((acc, t) => applyPatch(acc, t), list)
    )
  }
  ```

  `applyPatch` already dedupes by id and upserts; `mergeThreads` is just a batch wrapper. Every other store method (SSE handling, tombstones, `create`, `hide`, `setStatus`, `fetchNextPage`, etc.) is unchanged. `fetchNextPage()` survives for any other caller but is no longer used by the sidebar.

- **`useVirtualMCPs()`** (existing, reused) — the canonical agent directory hook from `@decocms/mesh-sdk` (`packages/mesh-sdk/src/hooks/use-virtual-mcp.ts:36`). React Query–backed, so the sidebar shares its cache with the rest of the app.

### Per-group pagination

Per-group pagination state lives in the sidebar, not in the store. A new hook `useGroupShowMore` owns `hasMore` and `isFetching` for one group; the offset is derived from the flat list (count of matching tasks).

```ts
function useGroupShowMore(kind: 'agent' | 'status', key: string) {
  const [hasMore, setHasMore] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const manager = useThreadManager()
  const filters = useSidebarFilters()

  const groupField = kind === 'agent' ? 'virtual_mcp_id' : 'status'
  const currentCount = useThreads().threads
    .filter(matchesFilters(filters))
    .filter(t => t[groupField] === key)
    .length

  async function loadMore() {
    setIsFetching(true)
    try {
      const result = await client.callTool({
        name: 'COLLECTION_THREADS_LIST',
        arguments: {
          where: { ...filters, [groupField]: key },
          limit: 10,
          offset: currentCount,
          orderBy: [{ field: ['updated_at'], direction: 'desc' }],
        },
      })
      const items = parseItems(result)
      manager.mergeThreads(items)
      setHasMore(items.length === 10)
    } finally {
      setIsFetching(false)
    }
  }

  return { hasMore, isFetching, loadMore }
}
```

The hook's `hasMore`/`isFetching` reset to defaults whenever the filter identity or grouping mode changes (dependency on filter object identity in the local state's reducer).

### Initial load

Unchanged path, smaller page:

```
COLLECTION_THREADS_LIST({
  limit: 10,
  offset: 0,
  orderBy: [{ field: ['updated_at'], direction: 'desc' }],
  where: filters,
})
```

`ThreadManagerStore.loadInitialPage()` already does this; only the `pageSize` constant changes from 50 to 10.

### Filter changes

A change to filters (`type`, `members`) triggers `loadInitialPage()` (existing behavior) and resets every `useGroupShowMore` instance's `hasMore` / `isFetching` via the dependency-change reset. In-flight `loadMore()` calls compare the captured filter identity at resolve time and drop stale responses.

### SSE / live updates

Unchanged. The current `handleWatchEvent` → `applyPatch` flow upserts into `threads`. Group rendering picks up the new task naturally on the next render. No per-group routing logic is needed because the flat list IS the single source of truth.

Per-group offsets get a small drift each time SSE inserts a row at the top: the next "show more" for that group may include the SSE-inserted row, but `applyPatch` dedupes it. Accepted as a minor inefficiency.

### Tradeoff: heterogeneous loaded-ness across groups

The flat list grows as the user clicks "show more" on different groups. After loading +10 tasks for agent X, agent Y's older tasks in the same age range are not loaded. Switching to status grouping mode would show, e.g., the `completed` group with mostly agent X's tasks until the user clicks "show more" on `completed`. This asymmetry is accepted: the flat list represents "what's loaded so far"; groups are views over it. Each group's "show more" resolves any local gap.

## UI

### Group rendering (agent mode)

`groupThreadsByVirtualMcp` is extended to return ALL agents from `useVirtualMCPs()`, partitioned into two tiers:

1. **Active** — agents with at least one task currently in the flat list. Sorted by `max(updated_at of group.threads)` desc. Stable-order persistence (`stable-order.ts`) still applies; the comparator becomes "by `latestUpdatedAt` desc, then preserved order."
2. **No recent activity** — agents with zero tasks in the flat list. Rendered inline below the active agents, sorted last, with dimmed styling and a "no recent activity" label in place of a timestamp.

### Group rendering (status mode)

Five fixed groups in the existing order: `requires_action` → `in_progress` → `failed` → `expired` → `completed`. Headers show status name + count of items currently loaded in the flat list that match this status (e.g., "In progress · 4"). The header count is a "loaded so far" count, not the server-side total.

### Group header (collapsed)

Per the Q6 decision (option D):
- Agent groups: name + icon + status dot of the most-recent task + `formatRelative(latestUpdatedAt)`.
- "No recent activity" agents: name + icon + dimmed "no recent activity" text, no status dot.
- Status groups: status name + loaded count.

### Group body (expanded)

- `TaskRow`s for the tasks belonging to this group (selected from the flat list by `virtual_mcp_id` or `status`, with the current sidebar filters applied), sorted by `updated_at` desc.
- A `ShowMoreButton` at the bottom of the list. Hidden when `!hasMore`. Shows a spinner when `isFetching`.

### Default expansion

Existing `use-group-expanded.ts` rules preserved:
- Agent mode: Decopilot expanded; the agent containing the currently-opened chat thread expanded; others collapsed; persisted per-org in localStorage.
- Status mode: `requires_action` and `in_progress` expanded; others collapsed.

### Removed UI

- `useInfiniteScroll` call and the sentinel element in `task-groups-list.tsx`.
- Any "Loading more…" spinner tied to the global `isFetchingMore` slot.

## Files

**Modified:**
- `apps/mesh/src/web/components/chat/store/thread-manager-store.ts` — add `mergeThreads(items)`; change `pageSize` from 50 to 10.
- `apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx` — remove infinite-scroll wiring; render groups as before.
- `apps/mesh/src/web/components/sidebar/task-groups/task-group.tsx` — `TaskGroup` and `StatusGroup` each render a `ShowMoreButton` at the bottom of their expanded body.
- `apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts` — `groupThreadsByVirtualMcp` returns ALL agents partitioned into active / no-recent-activity tiers; updated comparator.

**Added:**
- `apps/mesh/src/web/components/sidebar/task-groups/use-group-show-more.ts` — the hook above.
- `apps/mesh/src/web/components/sidebar/task-groups/show-more-button.tsx` — small button component bound to `useGroupShowMore`.

## Error handling

- **Initial seed failure** — already handled by `ThreadManagerStore` (sets `threadsStatus = { kind: 'error', error }`). The sidebar shows the existing error fallback.
- **`Show more` failure** — toast (consistent with other chat-store errors); leave `hasMore = true` so the user can retry; already-loaded tasks stay; no flash of error UI inside the group body.
- **SSE disconnect/reconnect** — unchanged. `onWatchReconnect()` re-arms the buffer and re-fetches the initial page. Per-group `hasMore` state is not reset (already-loaded "show more" pages remain valid; SSE patches keep them current).
- **Stale response after filter change** — `loadMore()` captures filter identity at call time; on resolve, compares against current filter identity and drops the response if it changed.
- **Empty agent group with `hasMore` unknown** — show "Show more" once; if it returns zero items, hide and render "No tasks for this agent."
- **Empty org (no tasks at all)** — render the existing empty state above the agent directory; agent groups still render with all agents in the "no recent activity" tier.

## Testing

### Unit (`bun test`, co-located `*.test.ts`)

- `mergeThreads` is iterated `applyPatch`: dedupe by id, idempotent re-merge, no order assertion (sorted-insert is `applyPatch`'s contract, already tested).
- `groupThreadsByVirtualMcp` extension:
  - Agents-with-no-tasks tier appears after active agents.
  - Sort by `latestUpdatedAt` desc within active tier.
  - Stable-order preservation interacts correctly with the new comparator.
- `nextPageOffset(threads, kind, key, filters)` (pure helper extracted from `useGroupShowMore`): given a flat list and a group key, the next page's offset equals the count of matching tasks currently in the list.

### E2E (Playwright, `apps/mesh/e2e/tests/`)

- Sidebar renders initial 10 tasks; agents with tasks are at the top.
- "Show more" inside an agent group loads 10 more; button hides when the server returns fewer than 10.
- "Show more" inside a status group works in status mode.
- Switching grouping mode preserves loaded tasks (no refetch).
- Filter change (mine ↔ all) triggers reload and resets per-group `hasMore` state.
- A task created in another browser context appears in the sidebar within a couple of seconds (SSE smoke).
- Archiving a task removes its row; a late SSE event for the archived id does not resurrect the row (tombstone behavior).

## Open questions

None at design time. Resolved during brainstorming:

- Recentness is the only ordering axis (no status tiering).
- Initial page = 10; per-group page = 10.
- Agents with no tasks rendered inline at the bottom with "no recent activity," not in a separate bucket.
- `ThreadManagerStore` keeps its existing shape; only one new method (`mergeThreads`).
- Global infinite scroll is removed; "show more" is per-group only.
- `useVirtualMCPs()` is the agent directory source of truth.
