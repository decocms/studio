/**
 * The thread list's data + actions, independent of where it renders.
 *
 * Two surfaces consume this: the classic sidebar list (TaskGroupsList) and the
 * chat panel's threads menu (ThreadsMenu, used when the org is on the
 * first-class navigation — see `useNavV2`). Both need the same filters,
 * archive/reclaim flow and new-thread semantics, so the wiring lives here once
 * and each surface only owns its layout.
 */

import { useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { toast } from "sonner";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useT } from "@/i18n/use-t.ts";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";
import { authClient } from "@/lib/auth-client";
import { useThreadActions, useThreads } from "@/components/chat/store/hooks";
import { usePanelActions } from "@/layouts/shell-layout";
import { track } from "@/lib/posthog-client";
import type { Task } from "@/components/chat/task/types";
import { forgetThreadLayout } from "@/lib/thread-layout-memory";
import { useStudioTools } from "@/lib/studio-tools";
import { isDesktopAppEnvironment } from "@/hooks/use-is-desktop-app";
import { GlobalSearchDialog } from "@/layouts/tasks-panel/global-search-dialog";
import { ArchiveWorktreeDialog } from "./archive-worktree-dialog";
import { findArchiveFallback } from "./archive-fallback";
import { MyThreadsSection } from "./my-threads-section";
import type { SidebarFilters, SidebarTypeFilter } from "./next-page-offset";
import {
  archiveConfirmSteps,
  hasOpenSiblingOnBranch,
  worktreeReclaimTarget,
  type WorktreeReclaimTarget,
} from "./worktree-reclaim";

export type ThreadGroupBy = "flat" | "status";

export interface ThreadsPanel {
  /** Threads to render, already scope- and type-filtered, newest first. */
  threads: Task[];
  activeTaskId: string | null;
  filters: SidebarFilters;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  groupBy: ThreadGroupBy;
  setGroupBy: (value: ThreadGroupBy) => void;
  typeFilter: SidebarTypeFilter;
  setTypeFilter: (value: SidebarTypeFilter) => void;
  showAll: boolean;
  setShowAll: (value: boolean) => void;
  /** True when any filter is off its default — drives the filter button's dot. */
  filtersActive: boolean;
  selectTask: (task: Task) => void;
  archiveTask: (task: Task) => void;
  newThread: () => void;
  openSearch: () => void;
  /**
   * The pending worktree-reclaim confirm, or null. Render it in every layout
   * branch so a collapse or viewport change can't silently dismiss it.
   */
  reclaimDialog: React.ReactNode;
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
  const t = useT();
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
  const visibleThreads = allThreads.filter((thread) => !thread.hidden);
  const { hide, setScope } = useThreadActions();

  const navigate = useNavigate();
  const studio = useStudioTools();
  const { setTaskId, createNewTask } = usePanelActions();
  const params = useParams({ strict: false }) as { taskId?: string };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const activeTaskId = params.taskId ?? null;
  /**
   * The recipient is the URL's `virtualmcpid` (what the composer sends to),
   * falling back to the thread row's agent. Preferring the param keeps the
   * active-agent highlight in sync when a new chat is retargeted in place.
   */
  const activeAgentId =
    search.virtualmcpid ??
    allThreads.find((thread) => thread.id === activeTaskId)?.virtual_mcp_id ??
    null;
  const closeAfterNavigation = () => {
    onNavigate?.();
  };

  const sortedThreads = [...visibleThreads].sort((a, b) =>
    (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  );

  const [typeFilter, setTypeFilter] = useState<SidebarTypeFilter>("all");
  const [groupBy, setGroupBy] = useState<ThreadGroupBy>("flat");
  const [showAll, setShowAll] = useLocalStorage<boolean>(
    "sidebar-threads-scope-all",
    false,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);
  const openSearch = () => {
    track("tasks_panel_search_opened");
    setSearchEverOpened(true);
    setSearchOpen(true);
  };
  /**
   * Desktop only: the pending "archive the last chat on this branch and delete
   * its worktree?" confirm. Non-null ⇒ the dialog is up and the archive has NOT
   * happened yet.
   */
  const [reclaimPrompt, setReclaimPrompt] = useState<{
    task: Task;
    target: WorktreeReclaimTarget;
  } | null>(null);

  /**
   * Drives the per-status / per-group server pagination (status mode), where
   * `member: "mine"` scopes the query to the current user.
   */
  const filters: SidebarFilters = {
    type: typeFilter,
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

  const typeFiltered = (threads: Task[]) => {
    if (typeFilter === "automation") {
      return threads.filter((thread) => Boolean(thread.trigger_id));
    }
    if (typeFilter === "manual") {
      return threads.filter((thread) => !thread.trigger_id);
    }
    return threads;
  };

  /** Every agent's threads, mixed — an agent's own list lives on its home view. */
  const visibleScopedThreads = showAll
    ? typeFiltered(sortedThreads)
    : typeFiltered(mineFiltered(sortedThreads));

  /**
   * The archive itself. Nothing here runs until the reclaim confirm (if any)
   * has been answered — cancel must perform NONE of it.
   *
   * Resolves once the archive has actually landed on the server. Navigation
   * stays optimistic; only the returned promise reflects the write, and it
   * rejects (restoring the row) if the server refused — which is what the
   * worktree-reclaim path must wait on before deleting anything.
   */
  const archiveNow = (task: Task): Promise<void> => {
    const wasActive = task.id === activeTaskId;
    const archived = hide(task.id);
    // Forget the layout so it can't resurface if the id is ever reused.
    forgetThreadLayout(task.id);
    if (!wasActive) return archived;
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
    return archived;
  };

  const reclaimWorktree = async (target: WorktreeReclaimTarget) => {
    try {
      await studio.call("SANDBOX_DELETE", {
        virtualMcpId: target.virtualMcpId,
        branch: target.branch,
        // Desktop-gated path; this is the only possible provider here.
        sandboxProviderKind: "user-desktop",
        removeWorktree: true,
      });
    } catch {
      // A failed reclaim is a recoverable disk leak, not a broken UI state.
      toast.error(
        t("sidebar.archiveWorktreeDialog.reclaimFailed", {
          branch: target.branch,
        }),
      );
    }
  };

  /**
   * Archiving hides a thread org-wide, so it is owner-only. When the thread
   * holds the last worktree on its branch, the destructive reclaim is confirmed
   * first; otherwise the archive is fire-and-forget.
   *
   * `allThreads` is authoritative here, not a sample: on the desktop the thread
   * list is answered in full by the local intercept (see `list()` in
   * `intercept::thread_tools`) and kept live by SSE, which is what lets this
   * stay a synchronous local decision with no query behind it.
   */
  const archiveTask = (task: Task) => {
    if (currentUserId && task.created_by && task.created_by !== currentUserId) {
      return;
    }
    const target = worktreeReclaimTarget(task, isDesktopAppEnvironment());
    if (!target || hasOpenSiblingOnBranch(allThreads, target)) {
      void archiveNow(task);
      return;
    }
    setReclaimPrompt({ task, target });
  };

  /**
   * Archive first, then reclaim — and only if the archive actually landed. A
   * failed reclaim leaves an archived thread and a live worktree (recoverable);
   * the reverse would leave a visible chat whose worktree is gone, so a rejected
   * archive must abort the sequence before anything is deleted.
   */
  const handleReclaimOutcome = (outcome: "cancel" | "confirm") => {
    const prompt = reclaimPrompt;
    if (!prompt) return;
    setReclaimPrompt(null);
    void (async () => {
      for (const step of archiveConfirmSteps(outcome)) {
        if (step === "archive") {
          try {
            await archiveNow(prompt.task);
          } catch {
            return;
          }
        } else {
          await reclaimWorktree(prompt.target);
        }
      }
    })();
  };

  const selectTask = (task: Task) => {
    closeAfterNavigation();
    setTaskId(task.id, task.virtual_mcp_id);
  };

  /**
   * ALWAYS create a fresh chat on the currently selected agent (the active
   * thread's agent, else decopilot), inheriting the active thread's branch so it
   * lands on the same sandbox. We do not reuse an existing empty "New chat".
   */
  const newThread = () => {
    const currentAgentId = activeAgentId ?? decopilotId;
    const currentBranch =
      allThreads.find((thread) => thread.id === activeTaskId)?.branch ?? null;
    track("sidebar_new_thread_clicked", { virtual_mcp_id: currentAgentId });
    closeAfterNavigation();
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
    typeFilter,
    setTypeFilter,
    showAll,
    setShowAll,
    filtersActive: groupBy !== "flat" || typeFilter !== "all" || showAll,
    selectTask,
    archiveTask,
    newThread,
    openSearch,
    reclaimDialog: reclaimPrompt ? (
      <ArchiveWorktreeDialog
        branch={reclaimPrompt.target.branch}
        onOutcome={handleReclaimOutcome}
      />
    ) : null,
    searchDialog: searchEverOpened ? (
      <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    ) : null,
  };
}
