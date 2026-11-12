/**
 * The thread list's data + actions, independent of where it renders.
 *
 * The chat panel's threads menu (ThreadsMenu) consumes this: filters,
 * archive flow and new-thread semantics live here once, and the surface
 * only owns its layout.
 */

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";
import { authClient } from "@/lib/auth-client";
import { useThreadActions, useThreads } from "@/components/chat/store/hooks";
import { usePanelActions } from "@/layouts/shell-layout";
import { useRouteThreadId } from "@/layouts/thread-route";
import { track } from "@/lib/posthog-client";
import type { Task } from "@/components/chat/task/types";
import { findReusableNewChat } from "@/lib/reusable-new-chat";
import { hideAbandonedNewChats } from "@/lib/thread-list-visibility";
import { useProjectDefaultRuntime } from "@/sdk/project-default-runtime";
import { useSandboxOnlyChats } from "@/hooks/use-organization-settings";
import { forgetThreadLayout } from "@/lib/thread-layout-memory";
import { GlobalSearchDialog } from "@/layouts/tasks-panel/global-search-dialog";
import { findArchiveFallback } from "./archive-fallback";
import { MyThreadsSection } from "./my-threads-section";
import type { SidebarFilters } from "./next-page-offset";

export type ThreadGroupBy = "flat" | "status";

export interface ThreadsPanel {
  /** Threads to render, already scope-filtered, newest first. Automation runs are left out. */
  threads: Task[];
  activeTaskId: string | null;
  filters: SidebarFilters;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  groupBy: ThreadGroupBy;
  setGroupBy: (value: ThreadGroupBy) => void;
  showAll: boolean;
  setShowAll: (value: boolean) => void;
  /** True when any filter is off its default — drives the filter button's dot. */
  filtersActive: boolean;
  selectTask: (task: Task) => void;
  archiveTask: (task: Task) => void;
  newThread: () => void;
  /** Opens the org-wide search, starting from `query` when given. */
  openSearch: (query?: string) => void;
  /** The global search dialog, mounted once `openSearch` has fired at least once. */
  searchDialog: React.ReactNode;
}

/** The thread list, wired to a `ThreadsPanel` — shared by every surface that
 *  renders `MyThreadsSection` off `useThreadsPanel` (sidebar list, threads menu). */
export function ThreadsPanelList({ panel }: { panel: ThreadsPanel }) {
  return (
    <MyThreadsSection
      threads={panel.threads}
      groupBy={panel.groupBy}
      activeTaskId={panel.activeTaskId}
      onSelectTask={panel.selectTask}
      onArchiveTask={panel.archiveTask}
      filters={panel.filters}
      hasMore={panel.hasMore}
      isFetchingMore={panel.isFetchingMore}
      onLoadMore={panel.loadMore}
      filtersActive={panel.filtersActive}
    />
  );
}

export function useThreadsPanel({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}): ThreadsPanel {
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const projectDefaultRuntime = useProjectDefaultRuntime();
  const sandboxOnlyChats = useSandboxOnlyChats();

  const {
    threads: allThreads,
    hasMore,
    isFetchingMore,
    fetchNextPage,
  } = useThreads();
  const visibleThreads = allThreads.filter((thread) => !thread.hidden);
  const { hide, setScope } = useThreadActions();

  const navigate = useNavigate();
  const { setTaskId, createNewTask } = usePanelActions();
  /** Route-aware: `$taskId` on the legacy route, `?thread=` on a destination. */
  const activeTaskId = useRouteThreadId();
  const closeAfterNavigation = () => {
    onNavigate?.();
  };

  const sortedThreads = [...visibleThreads].sort((a, b) =>
    (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  );

  const [groupBy, setGroupBy] = useState<ThreadGroupBy>("flat");
  const [showAll, setShowAll] = useLocalStorage<boolean>(
    "sidebar-threads-scope-all",
    false,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);
  const [searchSeed, setSearchSeed] = useState({ query: "", count: 0 });
  const openSearch = (query = "") => {
    track("tasks_panel_search_opened");
    setSearchSeed((seed) => ({ query, count: seed.count + 1 }));
    setSearchEverOpened(true);
    setSearchOpen(true);
  };
  /**
   * Drives the per-status / per-group server pagination (status mode), where
   * `member: "mine"` scopes the query to the current user.
   */
  const filters: SidebarFilters = {
    // Automation runs live with their automations; the chat list is people's own conversations.
    type: "manual",
    member: "mine",
    currentUserId: currentUserId ?? null,
  };

  /**
   * Keep the shared thread feed scoped, server-side, to the current owner scope
   * (Mine/Team), so "Show more" pages matching rows instead of the org-wide
   * feed and then dropping them client-side. Idempotent — a no-op unless the
   * scope actually changed. The client-side filters below stay as defense
   * against live SSE rows arriving outside the current scope.
   *
   * Only `created_by` is pushed server-side, NOT the type filter: this store is
   * shared, and org-home / breadcrumb read it via `findReusableNewChat` to
   * reuse the user's empty manual "New chat". Narrowing by `has_trigger` would
   * hide that manual thread whenever the Automation filter is active, so those
   * readers would mint a duplicate. Type stays a client-side filter.
   */
  const scopeWhere: Record<string, unknown> = {};
  if (!showAll) scopeWhere.created_by = "me";
  setScope(scopeWhere);

  /** Empty until the session resolves, so no teammate's threads ever leak in. */
  const mineFiltered = (threads: Task[]) =>
    currentUserId
      ? threads.filter((thread) => thread.created_by === currentUserId)
      : [];

  const conversations = (threads: Task[]) =>
    threads.filter((thread) => !thread.trigger_id);

  /**
   * Every agent's threads, mixed — an agent's own list lives on its home view.
   * Abandoned empty "New chat" rows are dropped (the active one is kept) so the
   * list isn't buried under chats that were opened but never used.
   */
  const visibleScopedThreads = hideAbandonedNewChats(
    showAll
      ? conversations(sortedThreads)
      : conversations(mineFiltered(sortedThreads)),
    activeTaskId,
  );

  /**
   * Archiving hides a thread org-wide, so it is owner-only. Navigation stays
   * optimistic; the hide rejects (restoring the row) if the server refused.
   */
  const archiveTask = (task: Task) => {
    if (currentUserId && task.created_by && task.created_by !== currentUserId) {
      return;
    }
    const wasActive = task.id === activeTaskId;
    void hide(task.id);
    // Forget the layout so it can't resurface if the id is ever reused.
    forgetThreadLayout(task.id);
    if (!wasActive) return;
    const next = findArchiveFallback(
      visibleScopedThreads,
      task.id,
      currentUserId,
    );
    closeAfterNavigation();
    if (next) {
      setTaskId(next.id, next.virtual_mcp_id);
    } else {
      navigate({ to: "/$org", params: { org: org.slug } });
    }
  };

  const selectTask = (task: Task) => {
    closeAfterNavigation();
    setTaskId(task.id, task.virtual_mcp_id);
  };

  /** New chat with the org's assistant — reuse its empty one if any, else create. */
  const newThread = () => {
    const currentAgentId = decopilotId;
    track("sidebar_new_thread_clicked", { virtual_mcp_id: currentAgentId });
    closeAfterNavigation();
    const existing = findReusableNewChat(
      allThreads,
      currentAgentId,
      currentUserId,
      projectDefaultRuntime(currentAgentId),
    );
    if (existing) {
      setTaskId(existing.id, existing.virtual_mcp_id, { newThread: true });
      return;
    }
    // Sandbox-only chats get one sandbox each, so a new chat never inherits one.
    const currentBranch = sandboxOnlyChats
      ? null
      : (allThreads.find((thread) => thread.id === activeTaskId)?.branch ??
        null);
    createNewTask(currentAgentId, currentBranch);
  };

  return {
    threads: visibleScopedThreads,
    activeTaskId,
    filters,
    hasMore,
    isFetchingMore,
    loadMore: () => void fetchNextPage(),
    groupBy,
    setGroupBy,
    showAll,
    setShowAll,
    filtersActive: groupBy !== "flat" || showAll,
    selectTask,
    archiveTask,
    newThread,
    openSearch,
    searchDialog: searchEverOpened ? (
      // Remounts per opening, so each search starts from what was typed.
      <GlobalSearchDialog
        key={searchSeed.count}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        initialQuery={searchSeed.query}
      />
    ) : null,
  };
}
