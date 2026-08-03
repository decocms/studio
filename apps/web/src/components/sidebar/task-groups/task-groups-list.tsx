import { useState, type ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useT } from "@/i18n/use-t.ts";
import { ScrollFade } from "./scroll-fade";
import {
  Activity,
  Edit05,
  FilterLines,
  LayoutLeft,
  Rows01,
  SearchSm,
} from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@deco/ui/components/toggle-group.tsx";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { useThreadActions, useThreads } from "@/components/chat/store/hooks";
import { usePanelActions } from "@/layouts/shell-layout";
import { GlobalSearchDialog } from "@/layouts/tasks-panel/global-search-dialog";
import { track } from "@/lib/posthog-client";
import type { Task } from "@/components/chat/task/types";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { SidebarTriggerButton } from "@/layouts/shell-controls";
import { OrgIcon, OrgSwitcherPopover } from "@/components/header/org-switcher";
import { MyThreadsSection } from "./my-threads-section";
import type { SidebarFilters } from "./next-page-offset";
import { findArchiveFallback } from "./archive-fallback";
import { forgetThreadLayout } from "@/lib/thread-layout-memory";
import { toast } from "sonner";
import { useStudioTools } from "@/lib/studio-tools";
import { isDesktopAppEnvironment } from "@/hooks/use-is-desktop-app";
import { ArchiveWorktreeDialog } from "./archive-worktree-dialog";
import {
  archiveConfirmSteps,
  hasOpenSiblingOnBranch,
  worktreeReclaimTarget,
  type WorktreeReclaimTarget,
} from "./worktree-reclaim";

type TypeFilter = "all" | "manual" | "automation";
type GroupBy = "flat" | "status";

/** Toolbar icon button with the shared dark tooltip (matches the collapsed
 * rail's SidebarMenuButton tooltip). `active` gives the pressed/highlighted look.
 *
 * Open state is driven purely by hover/focus (not Radix's defaults) so a click
 * doesn't dismiss the tooltip while the pointer is still over the button. */
function ToolbarTooltipButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          onClick={onClick}
          onPointerEnter={() => setOpen(true)}
          onPointerLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className={cn(
            "md:size-[34px] rounded-lg",
            active && "bg-sidebar-accent text-foreground",
          )}
        >
          {children}
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** One labelled segmented control (View / Type / Scope) in the filter popover. */
function FilterRow<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <ToggleGroup
        type="single"
        size="sm"
        value={value}
        onValueChange={(v) => v && onChange(v as T)}
        className="gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5"
      >
        {options.map((opt) => (
          <ToggleGroupItem
            key={opt.value}
            value={opt.value}
            className="h-6 gap-1.5 rounded-md border border-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-transparent data-[state=on]:border-border data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
          >
            {opt.icon}
            {opt.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function TaskGroupsList({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}) {
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
  const params = useParams({ strict: false }) as {
    taskId?: string;
  };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const activeTaskId = params.taskId ?? null;
  // The recipient is the URL's `virtualmcpid` (what the composer sends to),
  // falling back to the thread row's agent. Preferring the param keeps the
  // active-agent highlight in sync when a new chat is retargeted in place.
  const activeAgentId =
    search.virtualmcpid ??
    allThreads.find((t) => t.id === activeTaskId)?.virtual_mcp_id ??
    null;
  const closeAfterNavigation = () => {
    onNavigate?.();
  };

  const sortedThreads = [...visibleThreads].sort((a, b) =>
    (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  );

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("flat");
  const [showAll, setShowAll] = useLocalStorage<boolean>(
    "sidebar-threads-scope-all",
    false,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);
  // Desktop only: the pending "archive the last chat on this branch and delete
  // its worktree?" confirm. Non-null ⇒ the dialog is up and the archive has
  // NOT happened yet.
  const [reclaimPrompt, setReclaimPrompt] = useState<{
    task: Task;
    target: WorktreeReclaimTarget;
  } | null>(null);

  // `filters` drives the per-status / per-group server pagination (status mode),
  // where `member: "mine"` scopes the query to the current user.
  const filters: SidebarFilters = {
    type: typeFilter,
    member: "mine",
    currentUserId: currentUserId ?? null,
  };

  // Keep the shared thread feed scoped, server-side, to the current owner scope
  // (Mine/Team), so "Show more" pages matching rows instead of the org-wide feed
  // and then dropping them client-side. Idempotent — a no-op unless the scope
  // actually changed. The client-side filters below stay as defense against live
  // SSE rows arriving outside the current scope.
  //
  // Only `created_by` is pushed server-side, NOT the type filter: this store is
  // shared, and org-home / breadcrumb read it via `findReusableNewChat` to reuse
  // the user's empty manual "New chat". Narrowing by `has_trigger` would hide
  // that manual thread whenever the Automation filter is active, so those
  // readers would mint a duplicate. Type stays a client-side filter.
  const scopeWhere: Record<string, unknown> = {};
  if (!showAll) scopeWhere.created_by = "me";
  setScope(scopeWhere);

  // Until the session resolves, `currentUserId` is undefined — render nothing
  // rather than leaking every member's threads into the "My threads" list.
  const mineFiltered = (threads: Task[]) =>
    currentUserId ? threads.filter((t) => t.created_by === currentUserId) : [];

  const typeFiltered = (threads: Task[]) => {
    if (typeFilter === "automation") {
      return threads.filter((t) => Boolean(t.trigger_id));
    }
    if (typeFilter === "manual") {
      return threads.filter((t) => !t.trigger_id);
    }
    return threads;
  };

  // Mine, in recency order — used both for display and to resolve an agent's
  // most-recent thread on click (ignores the type filter so the agent always
  // opens its latest thread).
  const myThreadsAll = mineFiltered(sortedThreads);
  const myThreads = typeFiltered(myThreadsAll);
  const allThreadsFiltered = typeFiltered(sortedThreads);
  // The sidebar always shows every thread (subject to the type/scope/view
  // filters) regardless of which agent is open — the agent's own filtered
  // threads live on its home view.
  const visibleScopedThreads = showAll ? allThreadsFiltered : myThreads;

  /** The archive itself. Nothing here runs until the reclaim confirm (if any)
   * has been answered — cancel must perform NONE of it. */
  /** Resolves once the archive has actually landed on the server. Navigation
   *  below stays optimistic; only the returned promise reflects the write, and
   *  it rejects (restoring the row) if the server refused — which is what the
   *  worktree-reclaim path must wait on before deleting anything. */
  const archiveNow = (task: Task): Promise<void> => {
    const wasActive = task.id === activeTaskId;
    const archived = hide(task.id);
    // Drop the archived thread's remembered layout so it can't resurface if a
    // new thread ever reuses the id within this session.
    forgetThreadLayout(task.id);
    if (!wasActive) return archived;
    // Follow the sidebar's current filtered order across agents, while keeping
    // teammate threads opt-in even when Team scope renders them.
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
        removeWorktree: true,
      });
    } catch {
      // The thread is already archived — a failed reclaim is a recoverable
      // disk leak, not a broken UI state. Say so rather than swallowing it.
      toast.error(
        t("sidebar.archiveWorktreeDialog.reclaimFailed", {
          branch: target.branch,
        }),
      );
    }
  };

  const handleArchive = (task: Task) => {
    // Archiving hides a thread org-wide, so it must be owner-only — the UI
    // withholds the affordance on teammates' rows, but guard here too in case
    // a caller ever wires it up without that check.
    if (currentUserId && task.created_by && task.created_by !== currentUserId) {
      return;
    }
    const target = worktreeReclaimTarget(task, isDesktopAppEnvironment());
    // No branch, or someone else is still on this one, so there is no worktree
    // to reclaim. Plain archive: nothing destructive follows, so the write is
    // fire-and-forget exactly as it was before the reclaim flow existed.
    //
    // `allThreads` is authoritative here, not a sample: on the desktop the
    // thread list is answered in full by the local intercept (see `list()` in
    // `intercept::thread_tools`), and kept live by SSE. That is what lets this
    // stay a synchronous local decision with no query behind it.
    if (!target || hasOpenSiblingOnBranch(allThreads, target)) {
      void archiveNow(task);
      return;
    }
    setReclaimPrompt({ task, target });
  };

  const handleReclaimOutcome = (outcome: "cancel" | "confirm") => {
    const prompt = reclaimPrompt;
    if (!prompt) return;
    setReclaimPrompt(null);
    // Archive first, then reclaim — and only if the archive actually landed.
    // A failed reclaim leaves an archived thread and a live worktree
    // (recoverable). The reverse would leave a visible chat whose worktree is
    // gone, so a rejected archive (optimisticHide restores the row and
    // rethrows) must abort the sequence before anything is deleted.
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

  // Rendered in every layout branch: once the confirm is up it must survive a
  // sidebar collapse or a viewport change, since dismissing it silently would
  // read as "cancelled" while leaving the user no way back to the decision.
  const reclaimDialog = reclaimPrompt ? (
    <ArchiveWorktreeDialog
      branch={reclaimPrompt.target.branch}
      onOutcome={handleReclaimOutcome}
    />
  ) : null;

  const handleSelectTask = (t: Task) => {
    closeAfterNavigation();
    setTaskId(t.id, t.virtual_mcp_id);
  };

  // New thread: ALWAYS create a fresh chat on the currently selected agent (the
  // active thread's agent, else decopilot), inheriting the active thread's
  // branch so it lands on the same sandbox/branch. Every click creates — we do
  // not reuse/refocus an existing empty "New chat".
  const handleNewThread = () => {
    const currentAgentId = activeAgentId ?? decopilotId;
    const currentBranch =
      allThreads.find((t) => t.id === activeTaskId)?.branch ?? null;
    track("sidebar_new_thread_clicked", { virtual_mcp_id: currentAgentId });
    closeAfterNavigation();
    createNewTask(currentAgentId, currentBranch);
  };

  const { state: sidebarState, isMobile, toggleSidebar } = useSidebar();

  const isCollapsed = sidebarState === "collapsed" && !isMobile;

  // Collapsed rail: the toggle up top, then a search button so threads stay
  // reachable without expanding.
  //
  // The rail is pinned to the collapsed icon width (var(--sidebar-width-icon) -
  // px-2) so its icons don't reflow while the sidebar animates its width down on
  // collapse: without the pin they'd render centered in the still-wide sidebar,
  // then slide left as it shrinks — that horizontal drift is the "flick".
  if (isCollapsed) {
    return (
      <div className="flex flex-col min-h-0 flex-1 -mt-1 w-[calc(var(--sidebar-width-icon)-1rem)]">
        {/* Mirror the OPEN sidebar's top exactly so nothing jumps when toggling:
            the org sits in an h-12 slot (= the open header's height) pulled flush
            to the top via -mt-1 (cancels the collapsed additionalContent margin),
            then an mt-2 before the menu reproduces the open header→toolbar gap so
            the collapse toggle lands at the same height as its open counterpart. */}
        <div className="flex h-12 shrink-0 items-center justify-center">
          <OrgSwitcherPopover
            orgParam={org.slug}
            side="right"
            align="start"
            trigger={
              <SidebarMenuButton tooltip={org.name}>
                <OrgIcon org={org} size="sm" />
              </SidebarMenuButton>
            }
          />
        </div>
        <SidebarMenu className="mt-2 min-h-0 gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label={t("sidebar.taskGroupsList.toggleSidebar")}
              tooltip={t("sidebar.taskGroupsList.toggleSidebar")}
              onClick={toggleSidebar}
            >
              <LayoutLeft size={16} />
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* New chat lives in the panel header when the sidebar is collapsed
              (see workspace-panel-group), so it's intentionally omitted from the
              collapsed rail to avoid duplicating it. */}
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label={t("sidebar.taskGroupsList.searchChats")}
              tooltip={t("sidebar.taskGroupsList.searchChats")}
              onClick={() => {
                track("tasks_panel_search_opened");
                setSearchEverOpened(true);
                setSearchOpen(true);
              }}
            >
              <SearchSm size={16} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {searchEverOpened && (
          <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
        )}
        {reclaimDialog}
      </div>
    );
  }

  const filtersActive =
    groupBy !== "flat" || typeFilter !== "all" || showAll === true;

  const filterPopover = (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ToolbarIconButton
              aria-label={t("sidebar.taskGroupsList.filterChats")}
              active={filtersActive}
              className="md:size-[34px] rounded-lg"
            >
              <FilterLines size={16} />
              {filtersActive && (
                <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary ring-2 ring-sidebar" />
              )}
            </ToolbarIconButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("sidebar.taskGroupsList.filterChats")}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64 flex flex-col gap-3 p-3">
        <FilterRow
          label={t("sidebar.taskGroupsList.filterView")}
          value={groupBy}
          onChange={(v) => {
            track("tasks_panel_group_by_changed", { to_value: v });
            setGroupBy(v);
          }}
          options={[
            {
              value: "flat",
              label: t("sidebar.taskGroupsList.viewList"),
              icon: <Rows01 size={13} />,
            },
            {
              value: "status",
              label: t("sidebar.taskGroupsList.viewStatus"),
              icon: <Activity size={13} />,
            },
          ]}
        />
        <FilterRow
          label={t("sidebar.taskGroupsList.filterType")}
          value={typeFilter}
          onChange={(v) => {
            track("tasks_panel_filter_changed", { to_value: v });
            setTypeFilter(v);
          }}
          options={[
            { value: "all", label: t("sidebar.taskGroupsList.typeAll") },
            { value: "manual", label: t("sidebar.taskGroupsList.typeChats") },
            {
              value: "automation",
              label: t("sidebar.taskGroupsList.typeAuto"),
            },
          ]}
        />
        <FilterRow
          label={t("sidebar.taskGroupsList.filterScope")}
          value={showAll ? "team" : "mine"}
          onChange={(v) => setShowAll(v === "team")}
          options={[
            { value: "mine", label: t("sidebar.taskGroupsList.scopeMine") },
            { value: "team", label: t("sidebar.taskGroupsList.scopeTeam") },
          ]}
        />
      </PopoverContent>
    </Popover>
  );

  const toolbar = (mobile: boolean) => (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "shrink-0 flex items-center justify-between",
          mobile ? "h-10" : "h-10 md:h-[34px] mb-2",
        )}
      >
        {/* Left: sidebar trigger + filter popover. */}
        <div className="flex items-center gap-0.5">
          {!mobile && (
            <SidebarTriggerButton className="md:size-[34px] rounded-lg" />
          )}
          {filterPopover}
        </div>
        {/* Right: search + new thread. */}
        <div className="flex items-center gap-0.5">
          <ToolbarTooltipButton
            label={t("sidebar.taskGroupsList.searchChats")}
            onClick={() => {
              track("tasks_panel_search_opened");
              setSearchEverOpened(true);
              setSearchOpen(true);
            }}
          >
            <SearchSm size={16} />
          </ToolbarTooltipButton>
          <ToolbarTooltipButton
            label={t("sidebar.taskGroupsList.newChat")}
            onClick={() => void handleNewThread()}
          >
            <Edit05 size={16} />
          </ToolbarTooltipButton>
        </div>
      </div>
    </TooltipProvider>
  );

  if (isMobile) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {toolbar(true)}
        <ScrollFade
          wrapperClassName="flex-1 min-h-0"
          className="flex flex-col gap-0.5 overflow-y-auto overscroll-contain px-1 h-full"
        >
          <MyThreadsSection
            threads={visibleScopedThreads}
            groupBy={groupBy}
            activeTaskId={activeTaskId}
            onSelectTask={handleSelectTask}
            onArchiveTask={handleArchive}
            filters={filters}
            hasMore={hasMore}
            isFetchingMore={isFetchingMore}
            onLoadMore={() => void fetchNextPage()}
            filtersActive={filtersActive}
          />
        </ScrollFade>
        {searchEverOpened && (
          <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
        )}
        {reclaimDialog}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {toolbar(false)}
      <div className="flex-1 min-h-0 flex flex-col gap-0.5 -mr-2 pr-2">
        <ScrollFade
          wrapperClassName="flex-1 min-h-0"
          className="flex flex-col gap-0.5 overflow-y-auto overscroll-contain h-full"
        >
          <MyThreadsSection
            threads={visibleScopedThreads}
            groupBy={groupBy}
            activeTaskId={activeTaskId}
            onSelectTask={handleSelectTask}
            onArchiveTask={handleArchive}
            filters={filters}
            hasMore={hasMore}
            isFetchingMore={isFetchingMore}
            onLoadMore={() => void fetchNextPage()}
            filtersActive={filtersActive}
          />
        </ScrollFade>
      </div>
      {searchEverOpened && (
        <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      )}
      {reclaimDialog}
    </div>
  );
}
