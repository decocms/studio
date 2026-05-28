# Sidebar per-group pagination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sidebar's global infinite scroll with per-group "Show more" buttons. Each agent or status group gets its own paginated cursor, fetched on demand. The flat `ThreadManagerStore` stays the single source of truth.

**Architecture:** One new method on `ThreadManagerStore` (`mergeThreads`) lets per-group fetchers merge fetched tasks into the existing flat list. A new `useGroupShowMore` hook + `ShowMoreButton` component drives per-group pagination from the sidebar. `groupThreadsByVirtualMcp` is extended to surface every agent from the directory (active first, no-recent-activity inline at the bottom). The existing SSE flow is untouched.

**Tech Stack:** React 19 (no `useEffect`/`useMemo`/`useCallback`/`memo`), TypeScript, Bun, Tailwind v4 with design tokens, `@modelcontextprotocol/sdk` MCP client, Playwright for e2e. Spec: `docs/superpowers/specs/2026-05-28-sidebar-per-group-pagination-design.md`.

---

### Task 1: Add `mergeThreads` to `ThreadManagerStore` and drop initial page size to 10

**Files:**
- Modify: `apps/mesh/src/web/components/chat/store/thread-manager-store.ts`
- Test: `apps/mesh/src/web/components/chat/store/thread-manager-store.test.ts`

- [ ] **Step 1: Write the failing test for `mergeThreads`**

Append a new `describe` block to `apps/mesh/src/web/components/chat/store/thread-manager-store.test.ts`. Add it near the end of the existing file (after the last `describe`):

```ts
describe("ThreadManagerStore.mergeThreads", () => {
  afterEach(() => {
    __resetManagerRegistry();
    __resetRegistry();
  });

  it("appends new tasks and dedupes by id", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([
      { id: "a", title: "A", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const store = new ThreadManagerStore("org", "loc", { client, sse });
    // Wait for the initial page to land.
    await new Promise((r) => setTimeout(r, 0));

    store.mergeThreads([
      { id: "a", title: "A (updated)", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
      { id: "b", title: "B", created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-03T00:00:00Z" },
    ]);

    const list = store.threads.get();
    expect(list.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(list.find((t) => t.id === "a")?.title).toBe("A (updated)");
  });

  it("is a no-op for an empty batch", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([
      { id: "a", title: "A", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const store = new ThreadManagerStore("org", "loc", { client, sse });
    await new Promise((r) => setTimeout(r, 0));

    const before = store.threads.get();
    store.mergeThreads([]);
    expect(store.threads.get()).toBe(before);
  });
});
```

- [ ] **Step 2: Run the new tests — confirm they fail**

Run:
```bash
bun test apps/mesh/src/web/components/chat/store/thread-manager-store.test.ts -t "mergeThreads"
```
Expected: FAIL — `store.mergeThreads is not a function`.

- [ ] **Step 3: Implement `mergeThreads` and drop `pageSize` to 10**

In `apps/mesh/src/web/components/chat/store/thread-manager-store.ts`:

a) Change the `pageSize` constant. Locate:

```ts
  private readonly pageSize = 50;
```

Replace with:

```ts
  private readonly pageSize = 10;
```

b) Add a new public method on the class. Insert it right after the `patchThread(patch: RowPatch): void { ... }` method (around line 184):

```ts
  /**
   * Bulk-merge a list of tasks into the flat `threads` slot. Uses the
   * existing `applyPatch` upsert semantics: rows already in the list are
   * updated in-place; new rows are prepended with synthetic-row defaults.
   * Tombstones are honoured so a just-archived thread cannot be resurrected
   * by a per-group "show more" response that still contains the row.
   */
  mergeThreads(items: Task[]): void {
    if (items.length === 0) return;
    this.threads.update((list) =>
      items.reduce((acc, t) => {
        if (this.isTombstoned(t.id)) return acc;
        return applyPatch(acc, t);
      }, list),
    );
  }
```

- [ ] **Step 4: Re-run the tests — confirm pass**

Run:
```bash
bun test apps/mesh/src/web/components/chat/store/thread-manager-store.test.ts
```
Expected: PASS (all existing tests + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/components/chat/store/thread-manager-store.ts apps/mesh/src/web/components/chat/store/thread-manager-store.test.ts
git commit -m "feat(sidebar): add mergeThreads + reduce initial page size to 10"
```

---

### Task 2: Add `nextPageOffset` pure helper

The hook that drives per-group "show more" needs to compute the next offset from the flat list. Extracting that as a pure helper makes it unit-testable.

**Files:**
- Create: `apps/mesh/src/web/components/sidebar/task-groups/next-page-offset.ts`
- Test: `apps/mesh/src/web/components/sidebar/task-groups/next-page-offset.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/web/components/sidebar/task-groups/next-page-offset.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { Task } from "@/web/components/chat/task/types";
import { nextPageOffset, type SidebarFilters } from "./next-page-offset";

const t = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? "x",
  title: overrides.title ?? "x",
  created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
  updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
  ...overrides,
});

const noFilters: SidebarFilters = {
  type: "all",
  member: "all",
  currentUserId: null,
};

describe("nextPageOffset", () => {
  it("counts agent matches", () => {
    const threads = [
      t({ id: "1", virtual_mcp_id: "vm-a" }),
      t({ id: "2", virtual_mcp_id: "vm-b" }),
      t({ id: "3", virtual_mcp_id: "vm-a" }),
    ];
    expect(nextPageOffset(threads, "agent", "vm-a", noFilters)).toBe(2);
    expect(nextPageOffset(threads, "agent", "vm-b", noFilters)).toBe(1);
  });

  it("counts status matches", () => {
    const threads = [
      t({ id: "1", status: "in_progress" }),
      t({ id: "2", status: "completed" }),
      t({ id: "3", status: "in_progress" }),
    ];
    expect(nextPageOffset(threads, "status", "in_progress", noFilters)).toBe(2);
  });

  it("excludes hidden threads", () => {
    const threads = [
      t({ id: "1", virtual_mcp_id: "vm-a" }),
      t({ id: "2", virtual_mcp_id: "vm-a", hidden: true }),
    ];
    expect(nextPageOffset(threads, "agent", "vm-a", noFilters)).toBe(1);
  });

  it("applies the mine-only member filter", () => {
    const threads = [
      t({ id: "1", virtual_mcp_id: "vm-a", created_by: "user-1" }),
      t({ id: "2", virtual_mcp_id: "vm-a", created_by: "user-2" }),
    ];
    expect(
      nextPageOffset(threads, "agent", "vm-a", {
        type: "all",
        member: "mine",
        currentUserId: "user-1",
      }),
    ).toBe(1);
  });

  it("applies the automation type filter", () => {
    const threads = [
      t({ id: "1", virtual_mcp_id: "vm-a", trigger_id: "trg" }),
      t({ id: "2", virtual_mcp_id: "vm-a", trigger_id: null }),
    ];
    expect(
      nextPageOffset(threads, "agent", "vm-a", {
        type: "automation",
        member: "all",
        currentUserId: null,
      }),
    ).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run:
```bash
bun test apps/mesh/src/web/components/sidebar/task-groups/next-page-offset.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/mesh/src/web/components/sidebar/task-groups/next-page-offset.ts`:

```ts
import type { Task } from "@/web/components/chat/task/types";
import type { StatusKey } from "@/web/lib/task-status";

export type SidebarTypeFilter = "all" | "manual" | "automation";
export type SidebarMemberFilter = "all" | "mine";

export interface SidebarFilters {
  type: SidebarTypeFilter;
  member: SidebarMemberFilter;
  currentUserId: string | null;
}

export type GroupKind = "agent" | "status";

/**
 * Number of tasks currently loaded in the flat list that match the given
 * group and the active sidebar filters. This is the offset to pass to the
 * next per-group `COLLECTION_THREADS_LIST` call so the server skips rows
 * already known to the client.
 */
export function nextPageOffset(
  threads: Task[],
  kind: GroupKind,
  groupKey: string,
  filters: SidebarFilters,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.hidden) continue;
    if (kind === "agent" && thread.virtual_mcp_id !== groupKey) continue;
    if (kind === "status" && (thread.status ?? "completed") !== (groupKey as StatusKey)) continue;
    if (
      filters.member === "mine" &&
      filters.currentUserId &&
      thread.created_by !== filters.currentUserId
    ) {
      continue;
    }
    if (filters.type === "automation" && !thread.trigger_id) continue;
    if (filters.type === "manual" && thread.trigger_id) continue;
    count++;
  }
  return count;
}
```

- [ ] **Step 4: Run the test — confirm pass**

Run:
```bash
bun test apps/mesh/src/web/components/sidebar/task-groups/next-page-offset.test.ts
```
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/task-groups/next-page-offset.ts apps/mesh/src/web/components/sidebar/task-groups/next-page-offset.test.ts
git commit -m "feat(sidebar): add nextPageOffset pure helper"
```

---

### Task 3: Add `useGroupShowMore` hook

The hook owns per-group `hasMore` / `isFetching` state, derives the offset from the current flat list, and calls `COLLECTION_THREADS_LIST` then `manager.mergeThreads`. It resets `hasMore` when the filter identity or group key changes — without `useEffect`, using the set-state-during-render pattern.

**Files:**
- Create: `apps/mesh/src/web/components/sidebar/task-groups/use-group-show-more.ts`

(No unit tests — this hook touches the MCP client and React state. Coverage lives in the e2e test in Task 9. The pure offset math is already tested in Task 2.)

- [ ] **Step 1: Create the hook**

Create `apps/mesh/src/web/components/sidebar/task-groups/use-group-show-more.ts`:

```ts
import { useState } from "react";
import { SELF_MCP_ALIAS_ID, useMCPClient, useProjectContext } from "@decocms/mesh-sdk";
import { toast } from "sonner";
import {
  useThreadManager,
  useThreads,
} from "@/web/components/chat/store/hooks";
import type { Task } from "@/web/components/chat/task/types";
import { extractToolErrorMessage } from "@/web/components/chat/store/mcp-utils";
import {
  nextPageOffset,
  type GroupKind,
  type SidebarFilters,
} from "./next-page-offset";

const PAGE_SIZE = 10;

interface ShowMoreState {
  hasMore: boolean;
  isFetching: boolean;
  /** Identity snapshot — when filters or key change, state resets. */
  identity: string;
}

function makeIdentity(
  kind: GroupKind,
  key: string,
  filters: SidebarFilters,
): string {
  return [kind, key, filters.type, filters.member, filters.currentUserId ?? ""].join("|");
}

/**
 * Per-group "Show more" controller. Owns `hasMore`/`isFetching` for one
 * (kind, key, filters) tuple. Returns a `loadMore` callback that fetches
 * the next page from the server and merges it into the flat task list.
 *
 * `hasMore` resets to `true` whenever the identity (kind, key, filters)
 * changes. We use the "set state during render" pattern instead of
 * useEffect to comply with the no-useEffect lint rule.
 */
export function useGroupShowMore(
  kind: GroupKind,
  key: string,
  filters: SidebarFilters,
) {
  const identity = makeIdentity(kind, key, filters);
  const [state, setState] = useState<ShowMoreState>({
    hasMore: true,
    isFetching: false,
    identity,
  });
  if (state.identity !== identity) {
    setState({ hasMore: true, isFetching: false, identity });
  }

  const manager = useThreadManager();
  const { threads } = useThreads();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  async function loadMore(): Promise<void> {
    if (state.isFetching || !state.hasMore) return;
    const capturedIdentity = identity;
    setState((s) =>
      s.identity === capturedIdentity ? { ...s, isFetching: true } : s,
    );
    try {
      const where: Record<string, unknown> = {
        [kind === "agent" ? "virtual_mcp_id" : "status"]: key,
      };
      if (filters.member === "mine" && filters.currentUserId) {
        where.created_by = filters.currentUserId;
      }
      if (filters.type === "automation") where.has_trigger = true;
      if (filters.type === "manual") where.has_trigger = false;

      const offset = nextPageOffset(threads, kind, key, filters);

      const result = await client.callTool({
        name: "COLLECTION_THREADS_LIST",
        arguments: {
          where,
          limit: PAGE_SIZE,
          offset,
          orderBy: [{ field: ["updated_at"], direction: "desc" }],
        },
      });

      if ((result as { isError?: boolean }).isError) {
        throw new Error(
          extractToolErrorMessage(result, "COLLECTION_THREADS_LIST failed"),
        );
      }

      const items =
        ((result as { structuredContent?: { items?: Task[] } })
          .structuredContent?.items ?? []) as Task[];

      // Drop the response if the identity changed mid-flight (filters or
      // grouping switched).
      setState((s) => {
        if (s.identity !== capturedIdentity) return s;
        return {
          ...s,
          isFetching: false,
          hasMore: items.length === PAGE_SIZE,
        };
      });
      if (identity === capturedIdentity) manager.mergeThreads(items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not load more tasks: ${msg}`);
      setState((s) =>
        s.identity === capturedIdentity ? { ...s, isFetching: false } : s,
      );
    }
  }

  return { hasMore: state.hasMore, isFetching: state.isFetching, loadMore };
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
bun run --cwd=apps/mesh check
```
Expected: no errors. If the import path for `extractToolErrorMessage` is wrong, adjust to wherever the existing store imports it from (currently `./mcp-utils` relative to the store dir).

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/task-groups/use-group-show-more.ts
git commit -m "feat(sidebar): add useGroupShowMore hook"
```

---

### Task 4: Add `ShowMoreButton` component

**Files:**
- Create: `apps/mesh/src/web/components/sidebar/task-groups/show-more-button.tsx`

- [ ] **Step 1: Create the component**

Create `apps/mesh/src/web/components/sidebar/task-groups/show-more-button.tsx`:

```tsx
import { ChevronDown, LoadingDot } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { useGroupShowMore } from "./use-group-show-more";
import type { SidebarFilters, GroupKind } from "./next-page-offset";

interface ShowMoreButtonProps {
  kind: GroupKind;
  groupKey: string;
  filters: SidebarFilters;
}

export function ShowMoreButton({ kind, groupKey, filters }: ShowMoreButtonProps) {
  const { hasMore, isFetching, loadMore } = useGroupShowMore(
    kind,
    groupKey,
    filters,
  );
  if (!hasMore) return null;
  return (
    <button
      type="button"
      onClick={() => void loadMore()}
      disabled={isFetching}
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-muted-foreground",
        "hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "transition-colors disabled:cursor-progress disabled:opacity-60",
      )}
    >
      {isFetching ? <LoadingDot size={14} /> : <ChevronDown size={14} />}
      <span>{isFetching ? "Loading…" : "Show more"}</span>
    </button>
  );
}
```

- [ ] **Step 2: Verify icon imports exist**

`LoadingDot` may not be a real export. Run:
```bash
bun run --cwd=apps/mesh check
```
If the type-check fails on `LoadingDot`, swap it for an existing spinner already used in the codebase. Search for one:
```bash
```
Use the Grep tool:
- pattern: `from "@untitledui/icons"`
- output_mode: `content`
- head_limit: 30
- glob: `**/sidebar/**/*.tsx`

Pick a spinner-like icon already imported in the sidebar dir, or fall back to reusing `ChevronDown` with an `animate-spin` class.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/task-groups/show-more-button.tsx
git commit -m "feat(sidebar): add ShowMoreButton component"
```

---

### Task 5: Extend `groupThreadsByVirtualMcp` to include every agent from the directory

The directory of agents (`useVirtualMCPs()`) is the canonical list. The grouping function should seed an empty group for every agent so agents with no recent tasks still surface in the sidebar (rendered inline, "no recent activity"). The function gains a new required parameter.

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts`
- Test: `apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts`

- [ ] **Step 1: Update the existing tests to match the new signature**

In `apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts`, the existing tests call `groupThreadsByVirtualMcp(threads, decopilotId)`. The signature becomes `groupThreadsByVirtualMcp(threads, agents, decopilotId)`. Update every call to pass an empty agents array `[]` as the second argument:

```ts
// Before
groupThreadsByVirtualMcp([...], "vm-decopilot")
// After
groupThreadsByVirtualMcp([...], [], "vm-decopilot")
```

Apply this edit to every existing call in the file.

- [ ] **Step 2: Add new tests for directory merging**

Append a new `describe` block in `group-threads.test.ts`:

```ts
describe("groupThreadsByVirtualMcp — directory merging", () => {
  it("includes agents with no threads as empty groups after active ones", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "a",
          virtual_mcp_id: "vm-active",
          updated_at: "2026-05-01T00:00:00Z",
        }),
      ],
      [
        { id: "vm-active", title: "Active" },
        { id: "vm-idle", title: "Idle" },
      ] as unknown as Parameters<typeof groupThreadsByVirtualMcp>[1],
      null,
    );
    expect(result.map((g) => g.virtualMcpId)).toEqual(["vm-active", "vm-idle"]);
    expect(result.find((g) => g.virtualMcpId === "vm-idle")?.threads).toEqual([]);
  });

  it("sorts the inactive tier alphabetically by id when no agent title is present", () => {
    const result = groupThreadsByVirtualMcp(
      [],
      [
        { id: "vm-zzz", title: "Z" },
        { id: "vm-aaa", title: "A" },
      ] as unknown as Parameters<typeof groupThreadsByVirtualMcp>[1],
      null,
    );
    expect(result.map((g) => g.virtualMcpId)).toEqual(["vm-aaa", "vm-zzz"]);
  });

  it("still pins decopilot first even when it is in the agents directory", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "a",
          virtual_mcp_id: "vm-other",
          updated_at: "2026-05-01T00:00:00Z",
        }),
      ],
      [
        { id: "vm-decopilot", title: "Decopilot" },
        { id: "vm-other", title: "Other" },
      ] as unknown as Parameters<typeof groupThreadsByVirtualMcp>[1],
      "vm-decopilot",
    );
    expect(result.map((g) => g.virtualMcpId)).toEqual([
      "vm-decopilot",
      "vm-other",
    ]);
  });
});
```

- [ ] **Step 3: Run tests — confirm new ones fail**

Run:
```bash
bun test apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts
```
Expected: existing tests pass (after signature update), new tests fail because agents are not yet merged into the result.

- [ ] **Step 4: Modify the implementation**

Replace the body of `groupThreadsByVirtualMcp` in `apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts`. First update the import block at the top of the file to bring in `VirtualMCPEntity`:

```ts
import type { Task } from "@/web/components/chat/task/types";
import type { StatusKey } from "@/web/lib/task-status";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
```

Then replace the entire `groupThreadsByVirtualMcp` function with:

```ts
/**
 * Group threads by virtual_mcp_id, surfacing every agent from the directory.
 *
 * Ordering:
 *  - Decopilot pinned first (when provided).
 *  - Active agents (have at least one thread in `threads`) sorted by
 *    `max(updated_at)` desc.
 *  - Inactive agents (in the directory but with no thread in `threads`)
 *    rendered after, sorted alphabetically by `id`.
 *  - Threads without a `virtual_mcp_id` bucket under TOOL_CALL_RUNS_GROUP_KEY
 *    and appear last.
 *
 * Within an active group, thread order is preserved from the input (callers
 * already sort by `updated_at` desc — we don't re-sort).
 */
export function groupThreadsByVirtualMcp(
  threads: Task[],
  agents: VirtualMCPEntity[],
  decopilotVirtualMcpId: string | null,
): TaskGroupData[] {
  const byId = new Map<string, TaskGroupData>();

  // Seed every directory agent as an empty group; bucketing below may
  // populate them.
  for (const agent of agents) {
    byId.set(agent.id, {
      virtualMcpId: agent.id,
      threads: [],
      latestUpdatedAt: "",
    });
  }

  for (const thread of threads) {
    if (thread.id.startsWith("thrd_welcome_")) continue;
    const key = thread.virtual_mcp_id ?? TOOL_CALL_RUNS_GROUP_KEY;
    const existing = byId.get(key);
    if (existing) {
      existing.threads.push(thread);
      if ((thread.updated_at ?? "") > existing.latestUpdatedAt) {
        existing.latestUpdatedAt = thread.updated_at ?? "";
      }
    } else {
      byId.set(key, {
        virtualMcpId: key,
        threads: [thread],
        latestUpdatedAt: thread.updated_at ?? "",
      });
    }
  }

  if (decopilotVirtualMcpId && !byId.has(decopilotVirtualMcpId)) {
    byId.set(decopilotVirtualMcpId, {
      virtualMcpId: decopilotVirtualMcpId,
      threads: [],
      latestUpdatedAt: "",
    });
  }

  const decopilot =
    decopilotVirtualMcpId !== null ? byId.get(decopilotVirtualMcpId) : undefined;
  if (decopilot && decopilotVirtualMcpId) byId.delete(decopilotVirtualMcpId);

  const toolCallRuns = byId.get(TOOL_CALL_RUNS_GROUP_KEY);
  if (toolCallRuns) byId.delete(TOOL_CALL_RUNS_GROUP_KEY);

  const remaining = [...byId.values()];
  const active = remaining
    .filter((g) => g.threads.length > 0)
    .sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
  const inactive = remaining
    .filter((g) => g.threads.length === 0)
    .sort((a, b) => a.virtualMcpId.localeCompare(b.virtualMcpId));

  const result: TaskGroupData[] = [];
  if (decopilot) result.push(decopilot);
  result.push(...active, ...inactive);
  if (toolCallRuns) result.push(toolCallRuns);
  return result;
}
```

- [ ] **Step 5: Re-run tests — confirm pass**

Run:
```bash
bun test apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts
git commit -m "feat(sidebar): surface every directory agent in groupThreadsByVirtualMcp"
```

---

### Task 6: Render `ShowMoreButton` inside `TaskGroup` and `StatusGroup`

The per-group button lives at the bottom of each expanded group body. Both group types accept the new prop `filters` so they can wire the button to the active filters.

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/task-groups/task-group.tsx`

- [ ] **Step 1: Import the button and the filters type**

At the top of `apps/mesh/src/web/components/sidebar/task-groups/task-group.tsx`, add to the existing imports:

```ts
import { ShowMoreButton } from "./show-more-button";
import type { SidebarFilters } from "./next-page-offset";
```

- [ ] **Step 2: Extend `TaskGroupProps` with `filters`**

In the `TaskGroupProps` interface, add:

```ts
  filters: SidebarFilters;
```

- [ ] **Step 3: Render the button at the bottom of the expanded body in `TaskGroup`**

Inside `TaskGroup`, locate the expanded body:

```tsx
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1 pl-4">
          {threads.length === 0 && !isToolCallRuns ? (
            <button ... >
              ...
            </button>
          ) : (
            threads.map((task) => (
              <TaskRow ... />
            ))
          )}
        </div>
      )}
```

Replace with:

```tsx
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1 pl-4">
          {threads.length === 0 && !isToolCallRuns ? (
            <button
              type="button"
              onClick={() => onNewTaskInGroup(virtualMcpId)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-colors"
            >
              <Plus size={14} />
              <span>New thread</span>
            </button>
          ) : (
            threads.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                isActive={activeTaskId === task.id}
                onClick={() => onSelectTask(task)}
                onArchive={() => onArchiveTask(task)}
                showAutomationBadge={Boolean(task.trigger_id)}
              />
            ))
          )}
          {!isToolCallRuns && (
            <ShowMoreButton kind="agent" groupKey={virtualMcpId} filters={filters} />
          )}
        </div>
      )}
```

Update the function signature destructuring to include `filters`:

```tsx
export function TaskGroup({
  virtualMcpId,
  threads,
  isDecopilot,
  hasActiveTask,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  onNewTaskInGroup,
  onShowSettings,
  onHideGroup,
  dimmed,
  filters,
}: TaskGroupProps) {
```

- [ ] **Step 4: Extend `StatusGroup` props and render the button**

In the same file, extend the `StatusGroup` prop type (anonymous in the function signature) with `filters`:

```tsx
export function StatusGroup({
  status,
  threads,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  filters,
}: {
  status: StatusGroupData["status"];
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  filters: SidebarFilters;
}) {
```

Then, inside the existing expanded body:

```tsx
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1 pl-4">
          {threads.map((task) => (
            <TaskRow ... />
          ))}
        </div>
      )}
```

Replace with:

```tsx
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1 pl-4">
          {threads.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              isActive={activeTaskId === task.id}
              onClick={() => onSelectTask(task)}
              onArchive={() => onArchiveTask(task)}
              showAutomationBadge={Boolean(task.trigger_id)}
              showAgentIcon
              hideStatusIdle
            />
          ))}
          <ShowMoreButton kind="status" groupKey={status} filters={filters} />
        </div>
      )}
```

- [ ] **Step 5: Type-check**

Run:
```bash
bun run --cwd=apps/mesh check
```
Expected: the type-check errors will be in `task-groups-list.tsx` because the call sites don't pass `filters` yet — that's Task 7. Verify the errors are limited to that file. If there are unrelated errors in `task-group.tsx` itself, fix them inline.

- [ ] **Step 6: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/task-groups/task-group.tsx
git commit -m "feat(sidebar): render ShowMoreButton inside TaskGroup and StatusGroup"
```

---

### Task 7: Replace infinite scroll in `TaskGroupsList`

Remove the global infinite-scroll wiring (`useInfiniteScroll`, sentinel, `isFetchingMore` UI). Pass the agent directory from `useVirtualMCPs()` into `groupThreadsByVirtualMcp`. Pass the filters object into `TaskGroup` and `StatusGroup`.

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx`

- [ ] **Step 1: Update imports**

In `apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx`, remove the `useRef`, `useInfiniteScroll`, `hasMore`, `isFetchingMore`, `fetchNextPage` usage, and add the agent directory hook + filters type.

Replace the imports block (lines 1–41) with:

```tsx
import { useState, type ReactNode } from "react";
import { Activity, FilterLines, SearchSm, Users01 } from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { useNavigate, useParams } from "@tanstack/react-router";
import { authClient } from "@/web/lib/auth-client";
import {
  useThreadActions,
  useThreads,
} from "@/web/components/chat/store/hooks";
import { filterThreads } from "@/web/components/chat/task";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { GlobalSearchDialog } from "@/web/layouts/tasks-panel/global-search-dialog";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { BrowseAgentsButton } from "../browse-agents-button";
import { CollapsedGroupPopover } from "./collapsed-group-popover";
import {
  groupThreadsByVirtualMcp,
  groupThreadsByStatus,
} from "./group-threads";
import { stabilizeGroupOrder } from "./stable-order";
import { TaskGroup, StatusGroup } from "./task-group";
import type { SidebarFilters } from "./next-page-offset";
```

- [ ] **Step 2: Drop infinite-scroll state and switch to the agent directory**

Inside `TaskGroupsList`, change the `useThreads()` destructuring (lines 69–74) from:

```tsx
  const {
    threads: allThreads,
    hasMore,
    isFetchingMore,
    fetchNextPage,
  } = useThreads();
```

to:

```tsx
  const { threads: allThreads } = useThreads();
  const agents = useVirtualMCPs();
```

Then remove the `useRef` + `useInfiniteScroll` block (lines 97–103):

```tsx
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastElementRef = useInfiniteScroll(
    () => fetchNextPage(),
    hasMore,
    isFetchingMore,
    scrollRef,
  );
```

Replace with nothing — those lines are deleted entirely.

Change the `groups` line (lines 105–109) from:

```tsx
  const groups = stabilizeGroupOrder(
    org.id,
    groupThreadsByVirtualMcp(sortedThreads, decopilotId),
    decopilotId,
  );
```

to:

```tsx
  const groups = stabilizeGroupOrder(
    org.id,
    groupThreadsByVirtualMcp(sortedThreads, agents ?? [], decopilotId),
    decopilotId,
  );
```

- [ ] **Step 3: Build the filters object and pass it to children**

Just before the `return` of the non-collapsed branch (around line 186, after `const isCollapsed = ...`), add:

```tsx
  const filters: SidebarFilters = {
    type: typeFilter,
    member: memberFilter,
    currentUserId: currentUserId ?? null,
  };
```

In the `groupBy === "status"` branch, the `StatusGroup` render becomes:

```tsx
            {groupThreadsByStatus(
              typeFiltered(memberFiltered(sortedThreads)),
            ).map((group) => (
              <StatusGroup
                key={group.status}
                status={group.status}
                threads={group.threads}
                activeTaskId={activeTaskId}
                onSelectTask={(t) => setTaskId(t.id, t.virtual_mcp_id)}
                onArchiveTask={handleArchive}
                filters={filters}
              />
            ))}
```

(Remove the `{isFetchingMore && (...)}` "Loading more…" block and the `{hasMore && <div ref={lastElementRef} aria-hidden />}` sentinel that follow it.)

In the agent (`else`) branch, the `TaskGroup` render becomes:

```tsx
            {groups.map((group) => {
              const filtered = typeFiltered(memberFiltered(group.threads));
              const hasActiveTask = group.threads.some(
                (t) => t.id === activeTaskId,
              );
              const dimmed = filtersActive && filtered.length === 0;
              return (
                <TaskGroup
                  key={group.virtualMcpId}
                  virtualMcpId={group.virtualMcpId}
                  threads={filtered}
                  isDecopilot={group.virtualMcpId === decopilotId}
                  hasActiveTask={hasActiveTask}
                  activeTaskId={activeTaskId}
                  onSelectTask={(t) => setTaskId(t.id, t.virtual_mcp_id)}
                  onArchiveTask={handleArchive}
                  onNewTaskInGroup={handleNewInGroup}
                  onShowSettings={handleShowSettings}
                  onHideGroup={handleHideGroup}
                  dimmed={dimmed}
                  filters={filters}
                />
              );
            })}
```

(Remove the trailing `{isFetchingMore && ...}` and `{hasMore && ...}` blocks here too.)

- [ ] **Step 4: Drop the `scrollRef` from the outer scrolling div**

Find the wrapping div:

```tsx
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-0.5 -mr-2 pr-2"
      >
```

Replace with:

```tsx
      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-0.5 -mr-2 pr-2"
      >
```

- [ ] **Step 5: Type-check + lint + format**

Run:
```bash
bun run --cwd=apps/mesh check && bun run lint && bun run fmt
```
Expected: clean. If `useInfiniteScroll` no longer has any callers elsewhere, knip may flag it as unused — in that case delete `apps/mesh/src/web/hooks/use-infinite-scroll.ts` (verify with Grep first) and any test file beside it.

Verify by Grep: pattern `useInfiniteScroll`, output_mode `files_with_matches`. If only the hook file itself remains, remove it.

- [ ] **Step 6: Run unit tests**

```bash
bun test
```
Expected: PASS. If any test breaks because it imported `useInfiniteScroll`, update it.

- [ ] **Step 7: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx apps/mesh/src/web/hooks/use-infinite-scroll.ts 2>/dev/null || true
git commit -m "feat(sidebar): replace infinite scroll with per-group Show more"
```

If the hook file was deleted, the `git add` will include the deletion automatically; otherwise commit only the modified file.

---

### Task 8: Manual smoke + e2e happy path

The spec lists a broader e2e matrix. Implement the highest-value one here; the rest can land in follow-ups.

**Files:**
- Create: `apps/mesh/e2e/tests/sidebar-per-group-show-more.spec.ts`

- [ ] **Step 1: Start the dev server and exercise the flow manually**

Run in one terminal:
```bash
bun run dev
```

Open `http://localhost:4000`. Sign in. Open the sidebar with a non-trivial number of tasks. Verify:
- Sidebar paints quickly with ~10 tasks.
- Agents with at least one of those 10 tasks appear at the top.
- Agents from the directory with no tasks appear inline below, dimmed.
- Expanding an agent group shows a "Show more" button if there are more tasks.
- Clicking "Show more" loads 10 more tasks; the button hides when the server returns fewer than 10.
- Switching the grouping toggle to "status" shows status groups with a "Show more" button each.
- Creating a new task in another tab makes it appear in the current tab's sidebar within a few seconds.

If anything misbehaves, fix it inline before continuing.

- [ ] **Step 2: Write the e2e test**

Look at an existing e2e test to copy the bootstrap pattern. Read `apps/mesh/e2e/tests/connection-create.spec.ts` (or any neighbour) and follow its `test.describe` + `loginAs` setup verbatim.

Create `apps/mesh/e2e/tests/sidebar-per-group-show-more.spec.ts` following that established pattern, with a single happy-path test that:
1. Seeds 15 tasks against one agent (use the existing test helpers to call `COLLECTION_THREADS_CREATE`).
2. Loads the org page.
3. Asserts the sidebar shows that agent group, expanded, with ≤ 10 task rows.
4. Asserts a "Show more" button is visible inside that group.
5. Clicks "Show more"; asserts the row count grows to ≥ 15.
6. Asserts the "Show more" button is no longer visible.

If the codebase has a Playwright helper for seeding threads, use it (search with Grep: pattern `COLLECTION_THREADS_CREATE` inside `apps/mesh/e2e/`).

- [ ] **Step 3: Run the e2e test**

```bash
bun run --cwd=apps/mesh e2e --grep sidebar-per-group
```

(If the workspace exposes the Playwright runner under a different script name, use that. Search `apps/mesh/package.json` for the `e2e`/`test:e2e` script and adapt.)

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/e2e/tests/sidebar-per-group-show-more.spec.ts
git commit -m "test(e2e): sidebar per-group Show more happy path"
```

---

### Task 9: Final quality gates

- [ ] **Step 1: Format**

```bash
bun run fmt
```

- [ ] **Step 2: Lint**

```bash
bun run lint
```
Expected: clean. Fix any plugin violations (banned `useEffect`/`useMemo`/`useCallback`/`memo`, design-token mismatches, kebab-case file names) inline.

- [ ] **Step 3: Type-check**

```bash
bun run check
```
Expected: clean.

- [ ] **Step 4: Unit tests**

```bash
bun test
```
Expected: PASS.

- [ ] **Step 5: Commit any final cleanup**

If `fmt` rewrote files:

```bash
git add -A
git commit -m "chore(sidebar): post-implementation fmt + lint cleanup"
```

If nothing changed, skip the commit.

---

## Self-review checklist (done by author of this plan)

**Spec coverage**

| Spec section | Plan task |
|---|---|
| `mergeThreads` method | Task 1 |
| `pageSize` 50 → 10 | Task 1 |
| `useGroupShowMore` hook | Task 3 |
| `ShowMoreButton` | Task 4 |
| Group rendering changes (agent mode partition) | Task 5 |
| Default expansion / stable-order — unchanged behavior carries through | Tasks 5, 7 (no new code needed; existing `useGroupExpanded` + `stabilizeGroupOrder` still drive it) |
| `task-group.tsx` rendering Show more | Task 6 |
| `task-groups-list.tsx` rewire | Task 7 |
| Unit tests (`mergeThreads`, `nextPageOffset`, `groupThreadsByVirtualMcp` extension) | Tasks 1, 2, 5 |
| E2E happy path | Task 8 |
| Error handling: toast on Show more failure, leave `hasMore = true` | Task 3 |
| Stale-response drop after filter change | Task 3 (identity snapshot) |
| `useInfiniteScroll` removal | Task 7 |
| Format / lint / typecheck gates | Task 9 |

**Note:** The spec mentions "no recent activity" copy in the inline tier. The current `TaskGroupAvatarInner` / `TaskGroupLabelInner` already render whatever the directory provides; the visual treatment for the inline "no recent activity" agents (dimmed styling, absence of a status dot) is inherent to the existing `TaskGroup` render path because empty `threads` arrays already mean no `TaskRow`s. If you want explicit dimming for inactive agents in the header itself, add a `isInactive` prop to `TaskGroupProps` derived from `group.threads.length === 0` — but that's a polish item and not in the spec's hard requirements.

**Type / signature consistency**

- `SidebarFilters` defined in Task 2, used in Tasks 3, 4, 6, 7.
- `GroupKind = "agent" | "status"` defined in Task 2, used in Tasks 3, 4.
- `nextPageOffset(threads, kind, key, filters)` signature consistent across Tasks 2 and 3.
- `useGroupShowMore` return shape `{ hasMore, isFetching, loadMore }` consistent across Tasks 3 and 4.
- `groupThreadsByVirtualMcp(threads, agents, decopilotId)` signature consistent across Tasks 5, 6 (call sites), 7.

**Placeholder scan:** No TBD/TODO/handle-edge-cases. All code blocks are concrete.
