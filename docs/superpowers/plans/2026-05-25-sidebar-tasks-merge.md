# Sidebar + Tasks Panel Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the narrow icon-rail sidebar and the tasks panel into a single collapsible sidebar that groups tasks by `virtual_mcp_id`, with a Linear/Conductor-style layout.

**Architecture:** Reuse shadcn's `Sidebar` with `state=expanded|collapsed`. Group threads client-side over the existing `useThreads()` flat list — no API changes. The collapsed state shows VM group icons as the rail; hovering an icon opens a popover preview of that group. Keep `TaskRow` as-is minus the leading `McpAvatar`; the avatar moves to the group header.

**Tech Stack:** React 19 (no `useEffect`/`useMemo`/`useCallback`), shadcn `Sidebar`, TanStack Router, Bun test runner, Tailwind v4 design tokens, Biome.

**Source spec:** `docs/superpowers/specs/2026-05-25-sidebar-tasks-merge-design.md`

---

## File Structure

### New files

- `apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts` — pure function that groups `Task[]` by `virtual_mcp_id`, with Decopilot pinned first and the rest ordered by max `updated_at` desc.
- `apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts` — unit tests for the pure grouping function.
- `apps/mesh/src/web/components/sidebar/task-groups/use-group-expanded.ts` — per-group `expanded`/`collapsed` state persisted in `localStorage`.
- `apps/mesh/src/web/components/sidebar/task-groups/task-group.tsx` — single VM group: header row (icon · name · `＋`), accordion body of `TaskRow`s.
- `apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx` — orchestrator: groups the threads, renders the section header (search + filter menu), maps groups to `TaskGroup`s, owns infinite-scroll, applies filter dimming.
- `apps/mesh/src/web/components/sidebar/task-groups/collapsed-group-popover.tsx` — hover popover rendered around each group icon in the collapsed rail; shows the same accordion body.
- `apps/mesh/src/web/components/sidebar/browse-agents-button.tsx` — extracts the "Browse agents" popover trigger from `agents-section.tsx` into a standalone fixed top button.

### Modified files

- `apps/mesh/src/web/layouts/tasks-panel/task-row.tsx` — drop `McpAvatar` / `ToolCallRunAvatar`; render automation badge inline next to the title.
- `apps/mesh/src/web/components/sidebar/index.tsx` — replace `StudioSidebar` body with: fixed top buttons (Home + Browse + Connections + Balance) → `TaskGroupsList` → footer (Inbox · Settings · Account).
- `apps/mesh/src/web/components/sidebar/footer/inbox.tsx` — remove `CreditChipConditional` and `ConnectionsButton` (they move to the top fixed buttons section); keep Inbox + Settings + Account. Swap order in collapsed state so Settings renders *above* Account.
- `apps/mesh/src/web/hooks/use-project-sidebar-items.tsx` — strip plugin-driven items (`pluginItems`, `pluginGroupSections`, `pinnedViewsSection`) and `workflowsItem`. Keep `homeItem` only. (File still exists; may be inlined in a later cleanup.)
- `apps/mesh/src/web/layouts/org-shell-layout/index.tsx` — default `SidebarProvider` to `defaultOpen={true}`; remove `TasksWorkspaceLayout` wrapper around `<Outlet />`.
- `apps/mesh/src/web/layouts/agent-shell-layout/toggle-buttons.tsx` — drop the tasks-panel toggle button (replaced by shadcn `SidebarTrigger`).
- `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx` — remove `useOptionalTasksPanelState`, drop the prop that gates `onNewTask` on `tasksOpen`.

### Deleted files

- `apps/mesh/src/web/layouts/agent-shell-layout/tasks-panel-column.tsx`
- `apps/mesh/src/web/layouts/agent-shell-layout/tasks-workspace-layout.tsx`
- `apps/mesh/src/web/layouts/tasks-panel/index.tsx` (the standalone panel surface is gone; `tasks-section.tsx`, `task-row.tsx`, `mcp-avatar.tsx`, `global-search-dialog.tsx` are still used / re-used by the new sidebar).

### Untouched (but referenced)

- `apps/mesh/src/web/components/sidebar/agents-section.tsx` — entire file is deleted from the sidebar render path (no longer mounted), but kept on disk for reference until a follow-up cleanup. The new `browse-agents-button.tsx` is a thin extraction of its popover trigger.

---

## Task 1: Pure grouping function with tests

**Files:**
- Create: `apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts`
- Create: `apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { Task } from "@/web/components/chat/task/types";
import { groupThreadsByVirtualMcp } from "./group-threads";

const t = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? "x",
  title: overrides.title ?? "x",
  created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
  updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("groupThreadsByVirtualMcp", () => {
  it("pins the decopilot id first regardless of recency", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({ id: "a", virtual_mcp_id: "vm-other", updated_at: "2026-05-01T00:00:00Z" }),
        t({ id: "b", virtual_mcp_id: "vm-decopilot", updated_at: "2026-04-01T00:00:00Z" }),
      ],
      "vm-decopilot",
    );
    expect(result.map((g) => g.virtualMcpId)).toEqual(["vm-decopilot", "vm-other"]);
  });

  it("orders non-decopilot groups by max updated_at desc", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({ id: "a", virtual_mcp_id: "vm-1", updated_at: "2026-01-01T00:00:00Z" }),
        t({ id: "b", virtual_mcp_id: "vm-2", updated_at: "2026-03-01T00:00:00Z" }),
        t({ id: "c", virtual_mcp_id: "vm-1", updated_at: "2026-02-01T00:00:00Z" }),
      ],
      "vm-decopilot",
    );
    expect(result.map((g) => g.virtualMcpId)).toEqual(["vm-2", "vm-1"]);
  });

  it("preserves input order inside a group (matches updated_at desc of caller)", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({ id: "a", virtual_mcp_id: "vm-1", updated_at: "2026-03-01T00:00:00Z" }),
        t({ id: "b", virtual_mcp_id: "vm-1", updated_at: "2026-02-01T00:00:00Z" }),
        t({ id: "c", virtual_mcp_id: "vm-1", updated_at: "2026-01-01T00:00:00Z" }),
      ],
      "vm-decopilot",
    );
    expect(result[0].threads.map((th) => th.id)).toEqual(["a", "b", "c"]);
  });

  it("inserts decopilot as an empty group when it has no threads", () => {
    const result = groupThreadsByVirtualMcp(
      [t({ id: "a", virtual_mcp_id: "vm-other", updated_at: "2026-05-01T00:00:00Z" })],
      "vm-decopilot",
    );
    expect(result.map((g) => g.virtualMcpId)).toEqual(["vm-decopilot", "vm-other"]);
    expect(result[0].threads).toEqual([]);
  });

  it("buckets threads without virtual_mcp_id under a synthetic 'tool-call-runs' group at the end", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({ id: "a", virtual_mcp_id: "vm-1", updated_at: "2026-05-01T00:00:00Z" }),
        t({ id: "b", virtual_mcp_id: undefined, updated_at: "2026-04-01T00:00:00Z" }),
      ],
      "vm-decopilot",
    );
    const ids = result.map((g) => g.virtualMcpId);
    expect(ids[ids.length - 1]).toBe("__tool_call_runs__");
  });

  it("returns an empty array when no threads and no decopilot id is supplied", () => {
    const result = groupThreadsByVirtualMcp([], null);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the grouping function**

Create `apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts`:

```ts
import type { Task } from "@/web/components/chat/task/types";

/** Synthetic group key for threads with no virtual_mcp_id (tool-call runs etc). */
export const TOOL_CALL_RUNS_GROUP_KEY = "__tool_call_runs__";

export interface TaskGroupData {
  virtualMcpId: string;
  threads: Task[];
  /** Latest updated_at in the group (ISO). Empty string for empty groups. */
  latestUpdatedAt: string;
}

/**
 * Group threads by virtual_mcp_id with Decopilot pinned first.
 *
 * - `decopilotVirtualMcpId` is always present as the first entry (with an empty
 *   `threads` array if none of the input threads target it). Pass `null` to skip.
 * - Other groups are ordered by `max(updated_at)` desc.
 * - Threads with no `virtual_mcp_id` (tool-call runs) bucket under
 *   `TOOL_CALL_RUNS_GROUP_KEY` and appear last.
 * - Within a group, thread order is preserved from the input (callers already
 *   sort by `updated_at` desc — we don't re-sort).
 */
export function groupThreadsByVirtualMcp(
  threads: Task[],
  decopilotVirtualMcpId: string | null,
): TaskGroupData[] {
  const byId = new Map<string, TaskGroupData>();

  for (const thread of threads) {
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
    decopilotVirtualMcpId !== null
      ? byId.get(decopilotVirtualMcpId)
      : undefined;
  if (decopilot && decopilotVirtualMcpId) byId.delete(decopilotVirtualMcpId);

  const toolCallRuns = byId.get(TOOL_CALL_RUNS_GROUP_KEY);
  if (toolCallRuns) byId.delete(TOOL_CALL_RUNS_GROUP_KEY);

  const middle = [...byId.values()].sort((a, b) =>
    b.latestUpdatedAt.localeCompare(a.latestUpdatedAt),
  );

  const result: TaskGroupData[] = [];
  if (decopilot) result.push(decopilot);
  result.push(...middle);
  if (toolCallRuns) result.push(toolCallRuns);
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts
git commit -m "feat(sidebar): add pure groupThreadsByVirtualMcp function"
```

---

## Task 2: Per-group expanded/collapsed state hook (localStorage)

**Files:**
- Create: `apps/mesh/src/web/components/sidebar/task-groups/use-group-expanded.ts`

- [ ] **Step 1: Inspect the existing useLocalStorage hook**

Run: `cat apps/mesh/src/web/hooks/use-local-storage.ts | head -60`
Expected: the hook exposes `useLocalStorage<T>(key, defaultValue): [value, setValue]`. Confirm the signature; the next step depends on it.

- [ ] **Step 2: Write the hook**

Create `apps/mesh/src/web/components/sidebar/task-groups/use-group-expanded.ts`:

```ts
import { useLocalStorage } from "@/web/hooks/use-local-storage";

const STORAGE_KEY_PREFIX = "sidebar.group.expanded.";

/**
 * Per-group expanded/collapsed state persisted in localStorage.
 *
 * `defaultExpanded` is consulted only on first read (when no value is stored).
 * Subsequent toggles are sticky across reloads.
 */
export function useGroupExpanded(
  virtualMcpId: string,
  defaultExpanded: boolean,
): [boolean, (next: boolean) => void] {
  const [expanded, setExpanded] = useLocalStorage<boolean>(
    `${STORAGE_KEY_PREFIX}${virtualMcpId}`,
    defaultExpanded,
  );
  return [expanded, setExpanded];
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS (no new errors).

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sidebar/task-groups/use-group-expanded.ts
git commit -m "feat(sidebar): add useGroupExpanded localStorage hook"
```

---

## Task 3: Refactor TaskRow — drop avatar, inline automation badge

**Files:**
- Modify: `apps/mesh/src/web/layouts/tasks-panel/task-row.tsx`

- [ ] **Step 1: Apply the edit**

Open `apps/mesh/src/web/layouts/tasks-panel/task-row.tsx`. Replace the entire file with:

```tsx
import { cn } from "@deco/ui/lib/utils.js";
import { Archive, Zap } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { getStatusConfig } from "@/web/lib/task-status";
import { formatTimeAgo } from "@/web/lib/format-time";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { isSyntheticBranch } from "@/shared/is-synthetic-branch";
import { useClockTick } from "@/web/lib/use-clock-tick";
import type { Task } from "@/web/components/chat/task/types";

export function TaskRow({
  task,
  isActive,
  onClick,
  onArchive,
  showAutomationBadge,
}: {
  task: Task;
  isActive: boolean;
  onClick: () => void;
  onArchive: () => void;
  showAutomationBadge?: boolean;
}) {
  const config = getStatusConfig(task.status);
  const StatusIcon = config.icon;
  const isToolCallRun = task.metadata?.kind === "tool_call_run";
  const virtualMcp = useVirtualMCP(
    isToolCallRun ? undefined : task.virtual_mcp_id,
  );
  const githubRepo = getActiveGithubRepo(virtualMcp);
  useClockTick(60_000);

  const isAutomation = showAutomationBadge || Boolean(task.trigger_id);

  return (
    <div
      data-task-id={task.id}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group/row flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors",
        "focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-ring/50",
        isActive ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {isAutomation && (
            <Zap
              size={12}
              aria-label="Automation-triggered"
              className="shrink-0 text-blue-500"
            />
          )}
          <div className="text-sm text-foreground truncate">
            {task.title || "Untitled task"}
          </div>
        </div>
        {task.updated_at && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
            {task.branch && !isSyntheticBranch(task.branch) ? (
              <>
                <span className="truncate font-mono">{task.branch}</span>
                <span className="shrink-0">·</span>
              </>
            ) : githubRepo ? (
              <>
                <span className="truncate">
                  {githubRepo.owner}/{githubRepo.name}
                </span>
                <span className="shrink-0">·</span>
              </>
            ) : null}
            <span className="shrink-0">
              {formatTimeAgo(new Date(task.updated_at))}
            </span>
          </div>
        )}
      </div>
      <div className="shrink-0 grid [grid-template-areas:'slot'] items-center justify-items-center">
        <span
          className="[grid-area:slot] flex size-7 items-center justify-center group-hover/row:invisible"
          aria-label={config.label}
        >
          <StatusIcon
            size={14}
            className={cn(
              config.iconClassName,
              task.status === "in_progress" && "animate-spin",
            )}
          />
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Archive task"
              onClick={(e) => {
                e.stopPropagation();
                onArchive();
              }}
              className="[grid-area:slot] invisible group-hover/row:visible flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <Archive size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Archive</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify imports no longer reference McpAvatar**

Run: `grep -n "McpAvatar\|ToolCallRunAvatar" apps/mesh/src/web/layouts/tasks-panel/task-row.tsx`
Expected: no matches.

- [ ] **Step 3: Run typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/layouts/tasks-panel/task-row.tsx
git commit -m "feat(sidebar): drop avatar from TaskRow, inline automation badge"
```

---

## Task 4: TaskGroup component (header + accordion body)

**Files:**
- Create: `apps/mesh/src/web/components/sidebar/task-groups/task-group.tsx`

- [ ] **Step 1: Write the component**

Create `apps/mesh/src/web/components/sidebar/task-groups/task-group.tsx`:

```tsx
import { ChevronDown, ChevronRight, Plus } from "@untitledui/icons";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import { cn } from "@deco/ui/lib/utils.ts";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import { TOOL_CALL_RUNS_GROUP_KEY } from "./group-threads";
import { useGroupExpanded } from "./use-group-expanded";
import type { Task } from "@/web/components/chat/task/types";

export interface TaskGroupProps {
  virtualMcpId: string;
  threads: Task[];
  isDecopilot: boolean;
  /** Whether this group currently contains the active task — drives default expanded. */
  hasActiveTask: boolean;
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onNewTaskInGroup: (virtualMcpId: string) => void;
  /** When true, the group renders dimmed (used when filters wipe out the body). */
  dimmed: boolean;
}

export function TaskGroup({
  virtualMcpId,
  threads,
  isDecopilot,
  hasActiveTask,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  onNewTaskInGroup,
  dimmed,
}: TaskGroupProps) {
  const defaultExpanded = isDecopilot || hasActiveTask;
  const [expanded, setExpanded] = useGroupExpanded(virtualMcpId, defaultExpanded);
  const isToolCallRuns = virtualMcpId === TOOL_CALL_RUNS_GROUP_KEY;

  return (
    <div className={cn("flex flex-col", dimmed && "opacity-50")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        className={cn(
          "group/group flex items-center gap-1.5 px-1.5 py-1 rounded-md text-xs font-medium",
          "cursor-pointer hover:bg-accent/40",
        )}
      >
        <span className="shrink-0 text-muted-foreground">
          {expanded ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
        </span>
        <TaskGroupAvatar
          virtualMcpId={virtualMcpId}
          isToolCallRuns={isToolCallRuns}
        />
        <span className="flex-1 truncate">
          <TaskGroupLabel
            virtualMcpId={virtualMcpId}
            isToolCallRuns={isToolCallRuns}
          />
        </span>
        {!isToolCallRuns && !dimmed && (
          <button
            type="button"
            aria-label="New task in this agent"
            onClick={(e) => {
              e.stopPropagation();
              onNewTaskInGroup(virtualMcpId);
            }}
            className="invisible group-hover/group:visible flex size-6 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1">
          {threads.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              isActive={activeTaskId === task.id}
              onClick={() => onSelectTask(task)}
              onArchive={() => onArchiveTask(task)}
              showAutomationBadge={Boolean(task.trigger_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskGroupAvatar({
  virtualMcpId,
  isToolCallRuns,
}: {
  virtualMcpId: string;
  isToolCallRuns: boolean;
}) {
  if (isToolCallRuns) {
    return <AgentAvatar icon={null} name="⚙" size="xs" />;
  }
  return <TaskGroupAvatarInner virtualMcpId={virtualMcpId} />;
}

function TaskGroupAvatarInner({ virtualMcpId }: { virtualMcpId: string }) {
  const entity = useVirtualMCP(virtualMcpId);
  if (!entity) return <AgentAvatar icon={null} name="?" size="xs" />;
  return <AgentAvatar icon={entity.icon ?? null} name={entity.title} size="xs" />;
}

function TaskGroupLabel({
  virtualMcpId,
  isToolCallRuns,
}: {
  virtualMcpId: string;
  isToolCallRuns: boolean;
}) {
  if (isToolCallRuns) return <>Automation runs</>;
  return <TaskGroupLabelInner virtualMcpId={virtualMcpId} />;
}

function TaskGroupLabelInner({ virtualMcpId }: { virtualMcpId: string }) {
  const entity = useVirtualMCP(virtualMcpId);
  return <>{entity?.title ?? "Agent"}</>;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sidebar/task-groups/task-group.tsx
git commit -m "feat(sidebar): add TaskGroup accordion component"
```

---

## Task 5: TaskGroupsList orchestrator with section header (search + filter)

**Files:**
- Create: `apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx`

This component replaces the orchestration that lived in `apps/mesh/src/web/layouts/tasks-panel/tasks-section.tsx` and `apps/mesh/src/web/layouts/tasks-panel/index.tsx`.

- [ ] **Step 1: Write the component**

Create `apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx`:

```tsx
import { useRef, useState } from "react";
import {
  FilterLines,
  SearchSm,
  User02,
  Users03,
} from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useNavigate, useParams } from "@tanstack/react-router";
import { authClient } from "@/web/lib/auth-client";
import {
  useThreadActions,
  useThreads,
} from "@/web/components/chat/store/hooks";
import { filterThreads } from "@/web/components/chat/task";
import { useInfiniteScroll } from "@/web/hooks/use-infinite-scroll";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { GlobalSearchDialog } from "@/web/layouts/tasks-panel/global-search-dialog";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";
import { groupThreadsByVirtualMcp } from "./group-threads";
import { TaskGroup } from "./task-group";

type TypeFilter = "all" | "manual" | "automation";
type MemberFilter = "all" | "mine";

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: "All tasks",
  manual: "Chats",
  automation: "Automation",
};

const MEMBER_LABELS: Record<MemberFilter, string> = {
  all: "All members",
  mine: "Mine only",
};

export function TaskGroupsList() {
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;

  const {
    threads: allThreads,
    hasMore,
    isFetchingMore,
    fetchNextPage,
  } = useThreads();
  const visibleThreads = filterThreads(allThreads, { hidden: false });
  const { hide } = useThreadActions();

  const { setTaskId, createNewTask } = usePanelActions();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const activeTaskId = params.taskId ?? null;

  const sortedThreads = [...visibleThreads].sort((a, b) =>
    (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  );

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("mine");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastElementRef = useInfiniteScroll(
    () => fetchNextPage(),
    hasMore,
    isFetchingMore,
    scrollRef,
  );

  const groups = groupThreadsByVirtualMcp(sortedThreads, decopilotId);

  const memberFiltered = (threads: Task[]) =>
    memberFilter === "mine" && currentUserId
      ? threads.filter((t) => t.created_by === currentUserId)
      : threads;

  const typeFiltered = (threads: Task[]) => {
    if (typeFilter === "automation") {
      return threads.filter((t) => Boolean(t.trigger_id));
    }
    if (typeFilter === "manual") {
      return threads.filter((t) => !t.trigger_id);
    }
    return threads;
  };

  const handleArchive = (task: Task) => {
    const wasActive = task.id === activeTaskId;
    hide(task.id);
    if (!wasActive) return;
    const next = sortedThreads.find((t) => t.id !== task.id);
    if (next) {
      setTaskId(next.id, next.virtual_mcp_id);
    } else if (params.org) {
      navigate({
        to: "/$org",
        params: { org: params.org },
        search: { tasks: 0 },
      });
    }
  };

  const handleNewInGroup = (virtualMcpId: string) => {
    track("sidebar_group_new_clicked", { virtual_mcp_id: virtualMcpId });
    // Reuse the panel action that creates+navigates. It already lands on the
    // current virtualMcp; reseat the URL search to the requested group first.
    if (params.org) {
      navigate({
        to: "/$org",
        params: { org: params.org },
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          virtualmcpid: virtualMcpId,
        }),
      });
    }
    createNewTask();
  };

  const filtersActive = typeFilter !== "all" || memberFilter !== "all";

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 pl-2 pr-1 h-7 flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>Tasks</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Search threads"
            onClick={() => {
              track("tasks_panel_search_opened");
              setSearchEverOpened(true);
              setSearchOpen(true);
            }}
            className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
          >
            <SearchSm size={14} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Filter tasks"
                className={cn(
                  "flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground",
                  filtersActive && "text-purple-500",
                )}
              >
                <FilterLines size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={memberFilter}
                onValueChange={(v) => {
                  const next = v as MemberFilter;
                  if (next !== memberFilter) {
                    track("tasks_panel_member_filter_changed", {
                      to_value: next,
                    });
                  }
                  setMemberFilter(next);
                }}
              >
                {(Object.keys(MEMBER_LABELS) as MemberFilter[]).map((opt) => (
                  <DropdownMenuRadioItem key={opt} value={opt}>
                    {opt === "mine" ? (
                      <User02 size={14} className="mr-2" />
                    ) : (
                      <Users03 size={14} className="mr-2" />
                    )}
                    {MEMBER_LABELS[opt]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={typeFilter}
                onValueChange={(v) => {
                  const next = v as TypeFilter;
                  if (next !== typeFilter) {
                    track("tasks_panel_filter_changed", { to_value: next });
                  }
                  setTypeFilter(next);
                }}
              >
                {(Object.keys(TYPE_LABELS) as TypeFilter[]).map((opt) => (
                  <DropdownMenuRadioItem key={opt} value={opt}>
                    {TYPE_LABELS[opt]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-0.5"
      >
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
              dimmed={dimmed}
            />
          );
        })}
        {isFetchingMore && (
          <div className="py-2 text-center text-xs text-muted-foreground">
            Loading more…
          </div>
        )}
        {hasMore && <div ref={lastElementRef} aria-hidden />}
      </div>
      {searchEverOpened && (
        <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx
git commit -m "feat(sidebar): add TaskGroupsList with header search + filters"
```

---

## Task 6: Collapsed-state hover popover

**Files:**
- Create: `apps/mesh/src/web/components/sidebar/task-groups/collapsed-group-popover.tsx`

- [ ] **Step 1: Write the popover wrapper**

Create `apps/mesh/src/web/components/sidebar/task-groups/collapsed-group-popover.tsx`:

```tsx
import { useState } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@deco/ui/components/hover-card.tsx";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Plus } from "@untitledui/icons";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";

export interface CollapsedGroupPopoverProps {
  virtualMcpId: string;
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onNewTaskInGroup: (virtualMcpId: string) => void;
}

/**
 * In collapsed rail state, each VM group is represented by its avatar.
 * Hovering opens a popover preview that shows the same accordion body.
 */
export function CollapsedGroupPopover({
  virtualMcpId,
  threads,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  onNewTaskInGroup,
}: CollapsedGroupPopoverProps) {
  const [_open, setOpen] = useState(false);
  const entity = useVirtualMCP(virtualMcpId);

  return (
    <HoverCard
      openDelay={120}
      closeDelay={150}
      onOpenChange={(next) => {
        if (next) {
          track("sidebar_group_hover_popover_opened", {
            virtual_mcp_id: virtualMcpId,
          });
        }
        setOpen(next);
      }}
    >
      <SidebarMenuItem>
        <HoverCardTrigger asChild>
          <SidebarMenuButton tooltip={entity?.title ?? "Agent"}>
            <AgentAvatar
              icon={entity?.icon ?? null}
              name={entity?.title ?? "?"}
              size="xs"
            />
          </SidebarMenuButton>
        </HoverCardTrigger>
      </SidebarMenuItem>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 p-2"
      >
        <div className="flex items-center justify-between px-1 pb-1 text-xs font-medium">
          <span className="truncate">{entity?.title ?? "Agent"}</span>
          <button
            type="button"
            aria-label="New task in this agent"
            onClick={() => onNewTaskInGroup(virtualMcpId)}
            className="flex size-6 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-0.5 max-h-[60vh] overflow-y-auto">
          {threads.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No tasks yet
            </div>
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
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
```

- [ ] **Step 2: Verify the HoverCard primitive exists in the UI package**

Run: `ls packages/ui/src/components/hover-card.tsx`
Expected: file exists. If it doesn't, fall back to the shadcn `Popover` primitive (`@deco/ui/components/popover.tsx`) with `onPointerEnter`/`onPointerLeave` on the trigger and content, mirroring the shadcn HoverCard recipe.

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sidebar/task-groups/collapsed-group-popover.tsx
git commit -m "feat(sidebar): add collapsed-state hover popover for VM groups"
```

---

## Task 7: Extract "Browse agents" popover into its own button

**Files:**
- Create: `apps/mesh/src/web/components/sidebar/browse-agents-button.tsx`

The current "+" pink button in the rail is the `SidebarAgentsSection` "Browse agents" popover (see `agents-section.tsx:763-790`). We extract just the trigger + popover wrapper so it can be used as a fixed top button without rendering the whole agents list.

- [ ] **Step 1: Inspect the existing "Browse agents" popover content**

Run: `grep -n "popoverContent" apps/mesh/src/web/components/sidebar/agents-section.tsx | head -5`
Expected: line numbers around `const popoverContent = (` and references inside the desktop popover and mobile drawer. Confirm the variable name; the extraction reuses that JSX as a separate component.

- [ ] **Step 2: Refactor — move `popoverContent` into a named export**

Open `apps/mesh/src/web/components/sidebar/agents-section.tsx`. Find the JSX assigned to `popoverContent`. Extract it into a named export at the bottom of the file:

```tsx
// At the bottom of agents-section.tsx, after the default export
export function AgentBrowserContent(/* whatever props the popoverContent needs */) {
  /* paste the existing JSX here, swapping any local closure references for props */
  return <>{/* ... */}</>;
}
```

If `popoverContent` reads many local closures, refactor it into a function component first, then call it from both the mobile drawer and the (soon-to-be-deleted) inline popover. Wire it up to its required props (existing `useCreateAgentFromTemplate`, `useCreateVirtualMCP`, etc. — these hooks can be called inside `AgentBrowserContent` directly).

- [ ] **Step 3: Create the standalone button**

Create `apps/mesh/src/web/components/sidebar/browse-agents-button.tsx`:

```tsx
import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Plus } from "@untitledui/icons";
import { track } from "@/web/lib/posthog-client";
import { AgentBrowserContent } from "./agents-section";

export function BrowseAgentsButton() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (isMobile) {
    return (
      <>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Browse agents"
              className="bg-muted/75 hover:bg-sidebar-accent"
              onClick={() => {
                track("agent_browser_opened", { surface: "mobile_drawer" });
                setOpen(true);
              }}
            >
              <Plus className="!opacity-100" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <Drawer open={open} onOpenChange={setOpen} direction="bottom">
          <DrawerContent className="max-h-[85dvh] p-0">
            <DrawerTitle className="sr-only">Browse agents</DrawerTitle>
            <AgentBrowserContent onClose={() => setOpen(false)} />
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && !open) {
          track("agent_browser_opened", { surface: "desktop_popover" });
        }
        setOpen(next);
      }}
    >
      <SidebarMenu>
        <SidebarMenuItem>
          <PopoverTrigger asChild>
            <SidebarMenuButton
              tooltip="Browse agents"
              className="bg-muted/75 hover:bg-sidebar-accent"
            >
              <Plus className="!opacity-100" />
            </SidebarMenuButton>
          </PopoverTrigger>
        </SidebarMenuItem>
      </SidebarMenu>
      <PopoverContent
        className="w-[380px] p-0 overflow-hidden"
        side="right"
        align="start"
      >
        <AgentBrowserContent onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. If imports from `AgentBrowserContent` complain about props, add the props it needs (close callback, etc.) and update the call sites.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sidebar/browse-agents-button.tsx apps/mesh/src/web/components/sidebar/agents-section.tsx
git commit -m "refactor(sidebar): extract Browse agents popover into BrowseAgentsButton"
```

---

## Task 8: Strip plugin items and workflows from `useProjectSidebarItems`

**Files:**
- Modify: `apps/mesh/src/web/hooks/use-project-sidebar-items.tsx`

- [ ] **Step 1: Replace the hook body**

Open `apps/mesh/src/web/hooks/use-project-sidebar-items.tsx` and replace the whole file with:

```tsx
import { useProjectContext } from "@decocms/mesh-sdk";
import type {
  NavigationSidebarItem,
  SidebarSection,
} from "@/web/components/sidebar/types";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Home01 } from "@untitledui/icons";
import { usePanelActions } from "@/web/layouts/shell-layout";

export function useProjectSidebarItems(): SidebarSection[] {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const { setTasksOpen } = usePanelActions();
  const pathname = routerState.location.pathname;
  const slug = org.slug;

  const homeItem: NavigationSidebarItem = {
    key: "home",
    label: "Home",
    icon: <Home01 className="size-4!" />,
    isActive: pathname === `/${slug}` || pathname === `/${slug}/`,
    onClick: () => {
      setTasksOpen(false);
      navigate({ to: "/$org", params: { org: slug } });
    },
  };

  return [{ type: "items", items: [homeItem] }];
}
```

- [ ] **Step 2: Verify there are no remaining references to the stripped exports inside this module**

Run: `grep -n "pluginRootSidebarItems\|pluginSidebarGroups\|pinnedViewsSection\|workflowsItem" apps/mesh/src/web/hooks/use-project-sidebar-items.tsx`
Expected: no matches.

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. (Other files still reference `pluginRootSidebarItems` from `web/index.tsx`; that's fine — those exports remain available for any plugin that *would* call them; the sidebar just no longer renders them.)

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/hooks/use-project-sidebar-items.tsx
git commit -m "refactor(sidebar): strip plugin items, pinned views, and workflows entry"
```

---

## Task 9: Footer cleanup (move Credits + Connections to top, swap collapsed order)

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/footer/inbox.tsx`
- Create: `apps/mesh/src/web/components/sidebar/top-actions.tsx`

We split the footer: Credits + Connections become **fixed top buttons** rendered above the tasks section; Inbox + Settings + Account remain in the footer. In collapsed state, the footer order is Inbox → Settings → Account.

- [ ] **Step 1: Create the top-actions component**

Create `apps/mesh/src/web/components/sidebar/top-actions.tsx`:

```tsx
import { Suspense } from "react";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Coins04, ZapSquare } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { AddConnectionDialog } from "@/web/views/virtual-mcp/add-connection-dialog";
import { track } from "@/web/lib/posthog-client";
import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";
import { BrowseAgentsButton } from "./browse-agents-button";

class SilentErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {}
  override render(): ReactNode {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function creditColor(balanceDollars: number): string {
  if (balanceDollars <= 1) return "text-destructive";
  if (balanceDollars <= 5) return "text-amber-500 dark:text-amber-400";
  return "text-foreground/70";
}

function CreditChip() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data, isPending, isError } = useMCPToolCallQuery<
    { balanceCents: number } | undefined
  >({
    client,
    toolName: "AI_PROVIDER_CREDITS",
    toolArguments: { providerId: "deco" },
    staleTime: 60_000,
    select: (result) =>
      (result as { structuredContent?: { balanceCents: number } })
        .structuredContent,
  });
  const balanceDollars =
    data?.balanceCents != null ? data.balanceCents / 100 : null;
  const tooltipLabel =
    isPending || isError || balanceDollars == null
      ? "Credits"
      : `Credits: $${balanceDollars.toFixed(2)}`;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={tooltipLabel}
          className={cn(balanceDollars != null && creditColor(balanceDollars))}
          onClick={() =>
            navigate({
              to: "/$org/settings/ai-providers",
              params: { org: org.slug },
            })
          }
        >
          <Coins04 size={20} />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function CreditChipConditional() {
  const keys = useAiProviderKeys();
  const hasDecoKey = keys.some((k) => k.providerId === "deco");
  if (!hasDecoKey) return null;
  return <CreditChip />;
}

function ConnectionsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip="Connections"
            onClick={() => {
              track("connections_dialog_opened", {
                source: "sidebar_top",
                mode: "browse",
              });
              setOpen(true);
            }}
          >
            <ZapSquare size={20} />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <AddConnectionDialog
        mode="browse"
        open={open}
        onOpenChange={setOpen}
        defaultTab="all"
      />
    </>
  );
}

export function SidebarTopActions() {
  return (
    <div className="px-2 pb-2 flex flex-col gap-1">
      <BrowseAgentsButton />
      <ConnectionsButton />
      <SilentErrorBoundary>
        <Suspense fallback={null}>
          <CreditChipConditional />
        </Suspense>
      </SilentErrorBoundary>
    </div>
  );
}
```

- [ ] **Step 2: Trim the footer**

Open `apps/mesh/src/web/components/sidebar/footer/inbox.tsx`. Delete the `CreditChip`, `CreditChipConditional`, and `ConnectionsButton` components (they moved to `top-actions.tsx`). Keep `InvitationItem`, `usePendingInvitations`, `InboxButton`, `SettingsButton`, `SilentErrorBoundary`, and `SidebarInboxFooter`. Update `SidebarInboxFooter` to:

```tsx
export function SidebarInboxFooter() {
  return (
    <SidebarFooter className="px-2 pb-3 gap-1">
      <InboxButton />
      <SettingsButton />
      <SidebarMenu>
        <SidebarMenuItem>
          <AccountPopover />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
```

Confirm the imports at the top of the file no longer reference the deleted components (`Coins04`, `ZapSquare`, `useMCPClient`, `useMCPToolCallQuery`, `useAiProviderKeys`, `AddConnectionDialog`, etc.). Remove unused imports.

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sidebar/top-actions.tsx apps/mesh/src/web/components/sidebar/footer/inbox.tsx
git commit -m "refactor(sidebar): move credits + connections to top actions"
```

---

## Task 10: Wire the new `StudioSidebar` shell

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/index.tsx`

- [ ] **Step 1: Replace the file body**

Replace `apps/mesh/src/web/components/sidebar/index.tsx` with:

```tsx
import { ErrorBoundary } from "@/web/components/error-boundary";
import { useProjectSidebarItems } from "@/web/hooks/use-project-sidebar-items";
import { Suspense } from "react";
import { NavigationSidebar } from "./navigation";
import { MobileNavigationSidebar } from "./navigation-mobile";
import { SidebarInboxFooter } from "./footer/inbox";
import { SidebarInboxFooterMobile } from "./footer/inbox-mobile";
import { SidebarTopActions } from "./top-actions";
import { TaskGroupsList } from "./task-groups/task-groups-list";

export type {
  NavigationSidebarItem,
  SidebarSection,
  SidebarItemGroup,
  Invitation,
} from "./types";

export function StudioSidebar() {
  const sections = useProjectSidebarItems();

  return (
    <NavigationSidebar
      sections={sections}
      footer={<SidebarInboxFooter />}
      additionalContent={
        <ErrorBoundary>
          <Suspense
            fallback={
              <div className="px-2 py-2 text-xs text-muted-foreground">
                Loading tasks…
              </div>
            }
          >
            <SidebarTopActions />
            <TaskGroupsList />
          </Suspense>
        </ErrorBoundary>
      }
    />
  );
}

export function StudioSidebarMobile({ onClose }: { onClose: () => void }) {
  const sections = useProjectSidebarItems();

  return (
    <MobileNavigationSidebar
      sections={sections}
      onClose={onClose}
      footer={<SidebarInboxFooterMobile />}
      additionalContent={
        <ErrorBoundary>
          <Suspense fallback={null}>
            <SidebarTopActions />
            <TaskGroupsList />
          </Suspense>
        </ErrorBoundary>
      }
    />
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sidebar/index.tsx
git commit -m "feat(sidebar): wire StudioSidebar to TaskGroupsList + top actions"
```

---

## Task 11: Default sidebar to open and remove TasksWorkspaceLayout

**Files:**
- Modify: `apps/mesh/src/web/layouts/org-shell-layout/index.tsx`

- [ ] **Step 1: Edit OrgShellLayout**

Open `apps/mesh/src/web/layouts/org-shell-layout/index.tsx`. Apply the following changes:

1. Remove the `TasksWorkspaceLayout` import:
   ```diff
   -import { TasksWorkspaceLayout } from "@/web/layouts/agent-shell-layout/tasks-workspace-layout";
   ```
2. Remove the `TasksPanel` import:
   ```diff
   -import { TasksPanel } from "@/web/layouts/tasks-panel";
   ```
3. Switch `defaultOpen`:
   ```diff
   -      <SidebarProvider defaultOpen={false}>
   +      <SidebarProvider defaultOpen={true}>
   ```
4. Replace the desktop branch of the JSX so it no longer wraps in `TasksWorkspaceLayout`:
   ```tsx
   <div className="flex-1 min-h-0 flex flex-row">
     <Suspense fallback={<RouteFallback />}>
       <Outlet />
     </Suspense>
   </div>
   ```
5. In `MobileHomeToolbar`, drop the standalone `<TasksPanel />` from the mobile sheet (it now renders inside `StudioSidebarMobile`'s `additionalContent`):
   ```tsx
   <div className="flex h-full">
     <div
       className="w-full bg-sidebar flex flex-col overflow-y-auto group/sidebar"
       data-state="expanded"
     >
       <StudioSidebarMobile onClose={() => setOpenMobile(false)} />
     </div>
   </div>
   ```
6. Adjust `--sidebar-width-icon` to keep the collapsed rail at 56px (no change needed if the existing value is `"3.5rem"`).

- [ ] **Step 2: Confirm no other references to TasksWorkspaceLayout**

Run: `grep -rn "TasksWorkspaceLayout\|TasksPanelColumnInner" apps/mesh/src/web`
Expected: hits only inside the files marked for deletion (`tasks-workspace-layout.tsx`, `tasks-panel-column.tsx`).

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/layouts/org-shell-layout/index.tsx
git commit -m "refactor(layout): default sidebar open, drop TasksWorkspaceLayout"
```

---

## Task 12: Adjust toolbar toggle and agent-shell-layout

**Files:**
- Modify: `apps/mesh/src/web/layouts/agent-shell-layout/toggle-buttons.tsx`
- Modify: `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`

- [ ] **Step 1: Drop the tasks toggle from ToggleButtons**

Open `apps/mesh/src/web/layouts/agent-shell-layout/toggle-buttons.tsx`. Replace with:

```tsx
import { Edit05, MessageCircle01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { track } from "@/web/lib/posthog-client";

export interface ToggleButtonsProps {
  chatOpen: boolean;
  toggleChat: () => void;
  onNewTask?: () => void;
}

const TOGGLE_BASE =
  "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors";
const TOGGLE_ACTIVE = "bg-sidebar-accent text-sidebar-foreground";
const TOGGLE_INACTIVE =
  "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground";

export function ToggleButtons({
  chatOpen,
  toggleChat,
  onNewTask,
}: ToggleButtonsProps) {
  return (
    <>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              track("agent_toolbar_toggled", {
                button: "chat",
                next_state: !chatOpen ? "open" : "closed",
              });
              toggleChat();
            }}
            aria-pressed={chatOpen}
            className={cn(
              TOGGLE_BASE,
              chatOpen ? TOGGLE_ACTIVE : TOGGLE_INACTIVE,
            )}
          >
            <MessageCircle01 size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Chat</TooltipContent>
      </Tooltip>
      {onNewTask && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onNewTask}
              className={cn(TOGGLE_BASE, TOGGLE_INACTIVE)}
            >
              <Edit05 size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New task</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
```

- [ ] **Step 2: Update agent-shell-layout to drop the tasksOpen gate**

Open `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`. Find the line:

```tsx
const tasksOpen = useOptionalTasksPanelState()?.tasksOpen ?? false;
```

Replace it with the simpler:

```tsx
// New-task button is always available in the toolbar now that the tasks
// panel is part of the sidebar (no longer overlaps).
```

Then update the `<Toolbar.Toggles>` render to pass `onNewTask` unconditionally:

```diff
-<ToggleButtons
-  chatOpen={layout.chatOpen}
-  toggleChat={layout.toggleChat}
-  onNewTask={tasksOpen ? undefined : layout.createNewTask}
-/>
+<ToggleButtons
+  chatOpen={layout.chatOpen}
+  toggleChat={layout.toggleChat}
+  onNewTask={layout.createNewTask}
+/>
```

Remove the import for `useOptionalTasksPanelState`.

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/layouts/agent-shell-layout/toggle-buttons.tsx apps/mesh/src/web/layouts/agent-shell-layout/index.tsx
git commit -m "refactor(toolbar): drop tasks toggle, always expose new-task button"
```

---

## Task 13: Delete the orphan tasks-panel files

**Files:**
- Delete: `apps/mesh/src/web/layouts/agent-shell-layout/tasks-panel-column.tsx`
- Delete: `apps/mesh/src/web/layouts/agent-shell-layout/tasks-workspace-layout.tsx`
- Delete: `apps/mesh/src/web/layouts/tasks-panel/index.tsx`

- [ ] **Step 1: Confirm no remaining imports**

Run:
```bash
grep -rn "tasks-panel-column\|tasks-workspace-layout\|from \"@/web/layouts/tasks-panel\"" apps/mesh/src/web
```
Expected: only matches inside the files being deleted, or no matches.

- [ ] **Step 2: Delete the files**

```bash
rm apps/mesh/src/web/layouts/agent-shell-layout/tasks-panel-column.tsx
rm apps/mesh/src/web/layouts/agent-shell-layout/tasks-workspace-layout.tsx
rm apps/mesh/src/web/layouts/tasks-panel/index.tsx
```

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. If new errors surface, hunt down the importer and either re-export from the new sidebar component or update the import path to point at the still-existing helpers (`tasks-section.tsx`, `task-row.tsx`, `mcp-avatar.tsx`, `global-search-dialog.tsx`).

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add -A
git commit -m "chore(sidebar): remove orphan tasks-panel layout files"
```

---

## Task 14: Manual UI verification

**No file changes.** This is a manual gate to catch regressions before merge.

- [ ] **Step 1: Start the dev server**

Run: `bun run dev`
Expected: dev server boots; no compile errors in the console.

- [ ] **Step 2: Expanded sidebar smoke test**

In a browser on `http://localhost:4000`:

1. Sign in / land on an org with at least two virtualMCPs that have open tasks.
2. Confirm the sidebar shows: logo · Home / Browse / Connections / Balance · Tasks section · Inbox · Account row with settings gear.
3. Confirm Decopilot group is first, even if it has no tasks.
4. Confirm other groups are ordered by most-recent task in each group.
5. Click a group's chevron → collapses/expands. Reload — the state persists.
6. Click a group's `+` → a new task is created on that VM and the URL `?virtualmcpid=` updates.
7. Open the search popover, filter menu — both still work; filter dimming greys empty groups instead of removing them.

- [ ] **Step 3: Collapsed rail test**

Click the sidebar trigger / drag the rail handle so the sidebar collapses to ~56px.

1. Confirm the rail shows: logo · Home · `+ Browse` · Connections · Balance · 🔍 · group avatars (Decopilot first) · Inbox · Settings · Account.
2. Hover a group avatar → the popover preview opens, shows that group's tasks, and the per-group `+` button.
3. Click a task in the popover → navigates and the popover closes.

- [ ] **Step 4: Mobile smoke test**

Resize the browser to <768px (or use device emulation).

1. Open the mobile sheet via the hamburger.
2. Confirm the sidebar renders inline in the sheet — single panel, no nested narrow rail.
3. Verify the group accordion still works inside the sheet.

- [ ] **Step 5: Bun tests**

Run: `bun test apps/mesh/src/web/components/sidebar`
Expected: All pass.

- [ ] **Step 6: Full type-check + lint**

Run:
```bash
bun run check
bun run lint
bun run fmt:check
```
All three should pass.

- [ ] **Step 7: Commit**

If any minor fixes were made during the manual pass, commit them:

```bash
git add -A
git commit -m "fix(sidebar): manual-verification follow-ups"
```

If nothing changed, no commit needed.

---

## Self-Review

**Spec coverage** — each section of `2026-05-25-sidebar-tasks-merge-design.md` mapped to tasks:

| Spec section | Tasks |
|---|---|
| Layout (expanded + collapsed) | 4, 6, 10, 11 |
| Group anatomy | 3, 4 |
| Grouping behavior | 1, 5 |
| Per-group expanded state | 2, 4 |
| Filters (section header) | 5 |
| Collapsed-state hover popover | 6 |
| `+` Browse popover preserved | 7, 9, 10 |
| Footer (Inbox + Settings + Account, collapsed order) | 9, 10 |
| Plugin/workflows removed | 8 |
| Default sidebar open | 11 |
| Toolbar toggle adjustment | 12 |
| Dead-code removal | 13 |
| Manual verification | 14 |
| Telemetry events | 5, 6 |

**Placeholder scan** — no `TBD`, no "implement later", every code step shows the code. The one fuzzy spot is Task 7 step 2 ("refactor `popoverContent` into a named export") — the existing JSX is large and embedded in closures, so the plan tells the implementer to keep the existing JSX intact and just extract it; concrete prop wiring depends on the local closure shape, which is best read in situ.

**Type consistency** — `Task`, `TaskGroupData`, `TOOL_CALL_RUNS_GROUP_KEY`, `groupThreadsByVirtualMcp`, `useGroupExpanded`, `TaskGroup`, `TaskGroupsList`, `CollapsedGroupPopover`, `BrowseAgentsButton`, `SidebarTopActions` — all names used consistently across tasks.

**Risks / follow-ups**

- `agents-section.tsx` is large. Task 7's extraction strategy keeps it on disk (and just adds a new named export); a follow-up PR can delete the unused parts once we're confident nothing else still references them.
- `useGroupExpanded` defaults to `defaultExpanded` only on first read. If a user's localStorage has stale entries for archived VMs, that's harmless (just unused keys); a janitor pass can be a follow-up.
