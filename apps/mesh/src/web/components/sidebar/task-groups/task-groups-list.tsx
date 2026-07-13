import { useState, type ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { ScrollFade } from "./scroll-fade";
import {
  Activity,
  Edit05,
  FilterLines,
  LayoutLeft,
  Rows01,
  SearchSm,
  User01,
  Users01,
  Zap,
} from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import {
  getWellKnownDecopilotVirtualMCP,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { authClient } from "@/web/lib/auth-client";
import {
  useThreadActions,
  useThreads,
} from "@/web/components/chat/store/hooks";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { GlobalSearchDialog } from "@/web/layouts/tasks-panel/global-search-dialog";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { AgentAvatar } from "@/web/components/agent-icon";
import { SidebarTriggerButton } from "@/web/layouts/shell-controls";
import { MyThreadsSection } from "./my-threads-section";
import type { SidebarFilters } from "./next-page-offset";

type TypeFilter = "all" | "manual" | "automation";
type GroupBy = "flat" | "status";

/** Toolbar icon button with the shared dark tooltip (matches the collapsed
 * rail's SidebarMenuButton tooltip). `active` gives the pressed/highlighted look. */
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          onClick={onClick}
          className={cn(active && "bg-sidebar-accent text-foreground")}
        >
          {children}
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function TaskGroupsList({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}) {
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  // Agent entities (for the collapsed rail's per-thread avatars).
  const agents = useVirtualMCPs();

  const {
    threads: allThreads,
    hasMore,
    isFetchingMore,
    fetchNextPage,
  } = useThreads();
  const visibleThreads = allThreads.filter((thread) => !thread.hidden);
  const { hide } = useThreadActions();

  const navigate = useNavigate();
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

  // `filters` drives the per-status / per-group server pagination (status mode),
  // where `member: "mine"` scopes the query to the current user. The flat list,
  // by contrast, paginates the shared org-wide thread store and filters to the
  // active scope (My/All) client-side — so in "My" mode a "Show more" can page
  // in teammate-only rows that get filtered out.
  // ponytail: proper per-scope flat pagination needs a store fetch that accepts
  // a created_by filter; deferred as a follow-up.
  const filters: SidebarFilters = {
    type: typeFilter,
    member: "mine",
    currentUserId: currentUserId ?? null,
  };

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
  const memberScoped = showAll ? allThreadsFiltered : myThreads;

  // Agent scope is URL-driven: inside a thread the sidebar shows that thread's
  // agent's threads; on the org home it shows everything. Decopilot = all.
  const filterAgentId = activeTaskId ? activeAgentId : null;
  const visibleScopedThreads =
    filterAgentId && filterAgentId !== decopilotId
      ? memberScoped.filter((t) => t.virtual_mcp_id === filterAgentId)
      : memberScoped;

  const handleArchive = (task: Task) => {
    // Archiving hides a thread org-wide, so it must be owner-only — the UI
    // withholds the affordance on teammates' rows, but guard here too in case
    // a caller ever wires it up without that check.
    if (currentUserId && task.created_by && task.created_by !== currentUserId) {
      return;
    }
    const wasActive = task.id === activeTaskId;
    hide(task.id);
    if (!wasActive) return;
    // Land only on the caller's own threads — never teleport into a teammate's.
    const next = myThreadsAll.find(
      (t) => t.id !== task.id && t.virtual_mcp_id === task.virtual_mcp_id,
    );
    closeAfterNavigation();
    if (next) {
      setTaskId(next.id, next.virtual_mcp_id);
    } else {
      navigate({ to: "/$org", params: { org: org.slug } });
    }
  };

  const handleSelectTask = (t: Task) => {
    closeAfterNavigation();
    setTaskId(t.id, t.virtual_mcp_id);
  };

  // Verify a thread has no messages (an unsent "New chat"), so we can reuse it
  // instead of spawning another empty one. Failure → treat as non-empty.
  const isThreadEmpty = async (threadId: string): Promise<boolean> => {
    try {
      const res = await client.callTool({
        name: "COLLECTION_THREAD_MESSAGES_LIST",
        arguments: { thread_id: threadId, limit: 1, offset: 0 },
      });
      const payload = ((res as { structuredContent?: unknown })
        .structuredContent ?? res) as { items?: unknown[] };
      return (payload.items?.length ?? 0) === 0;
    } catch {
      return false;
    }
  };

  // New thread: always target the currently selected agent (the active
  // thread's agent, else decopilot). To avoid piling up empties, focus an
  // existing empty "New chat" for that agent (verified to have no messages)
  // instead of spawning another.
  const handleNewThread = async () => {
    const currentAgentId = activeAgentId ?? decopilotId;
    track("sidebar_new_thread_clicked", { virtual_mcp_id: currentAgentId });
    const candidate = myThreadsAll.find(
      (t) => t.virtual_mcp_id === currentAgentId && t.title === "New chat",
    );
    if (candidate && (await isThreadEmpty(candidate.id))) {
      closeAfterNavigation();
      setTaskId(candidate.id, currentAgentId);
      return;
    }
    closeAfterNavigation();
    createNewTask(currentAgentId);
  };

  const { state: sidebarState, isMobile, toggleSidebar } = useSidebar();

  const isCollapsed = sidebarState === "collapsed" && !isMobile;

  // Collapsed rail: the toggle up top, then each thread as its agent's avatar
  // (tooltip = title), so threads stay reachable without expanding.
  if (isCollapsed) {
    const decopilot = getWellKnownDecopilotVirtualMCP(org.id);
    const agentById = new Map((agents ?? []).map((a) => [a.id, a] as const));
    const resolveAgent = (id: string | undefined) =>
      (id ? agentById.get(id) : undefined) ??
      (id === decopilotId ? decopilot : undefined);
    return (
      <SidebarMenu className="min-h-0 gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Toggle first, then new thread, then the threads themselves. All
            SidebarMenuButtons so they share the rail's default sizing/padding. */}
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="Toggle sidebar" onClick={toggleSidebar}>
            <LayoutLeft size={16} />
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip="New thread"
            onClick={() => void handleNewThread()}
          >
            <Edit05 size={16} />
          </SidebarMenuButton>
        </SidebarMenuItem>
        {visibleScopedThreads.map((t) => {
          const agent = resolveAgent(t.virtual_mcp_id);
          return (
            <SidebarMenuItem key={t.id}>
              <SidebarMenuButton
                tooltip={t.title || "New chat"}
                isActive={t.id === activeTaskId}
                onClick={() => handleSelectTask(t)}
              >
                <AgentAvatar
                  icon={agent?.icon ?? null}
                  name={agent?.title ?? "Agent"}
                  size="2xs"
                />
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    );
  }

  // Two-state toggle: all tasks ↔ only automations.
  const toggleAutomations = () => {
    const next: TypeFilter = typeFilter === "automation" ? "all" : "automation";
    track("tasks_panel_filter_changed", { to_value: next });
    setTypeFilter(next);
  };

  const toolbar = (mobile: boolean) => (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "shrink-0 px-1 flex items-center justify-between",
          mobile ? "h-10" : "h-10 md:h-7 mb-2",
        )}
      >
        {/* Left: toggle + view filters. */}
        <div className="flex items-center gap-0.5">
          {!mobile && <SidebarTriggerButton />}
          {/* Tooltip reflects the current view mode. */}
          <ToolbarTooltipButton
            label={groupBy === "flat" ? "Show all threads" : "Group by status"}
            active={groupBy === "status"}
            onClick={() => {
              const next: GroupBy = groupBy === "flat" ? "status" : "flat";
              track("tasks_panel_group_by_changed", { to_value: next });
              setGroupBy(next);
            }}
          >
            {groupBy === "flat" ? <Rows01 size={16} /> : <Activity size={16} />}
          </ToolbarTooltipButton>
          {!mobile && (
            <ToolbarTooltipButton
              label={
                typeFilter === "automation" ? "Only Automations" : "All tasks"
              }
              active={typeFilter === "automation"}
              onClick={toggleAutomations}
            >
              {typeFilter === "automation" ? (
                <Zap size={16} />
              ) : (
                <FilterLines size={16} />
              )}
            </ToolbarTooltipButton>
          )}
          <ToolbarTooltipButton
            label={showAll ? "Show Team Threads" : "Show My Threads"}
            active={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? <Users01 size={16} /> : <User01 size={16} />}
          </ToolbarTooltipButton>
        </div>
        {/* Right: search + new thread. */}
        <div className="flex items-center gap-0.5">
          <ToolbarTooltipButton
            label="Search threads"
            onClick={() => {
              track("tasks_panel_search_opened");
              setSearchEverOpened(true);
              setSearchOpen(true);
            }}
          >
            <SearchSm size={16} />
          </ToolbarTooltipButton>
          <ToolbarTooltipButton
            label="New thread"
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
          />
        </ScrollFade>
        {searchEverOpened && (
          <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
        )}
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
          />
        </ScrollFade>
      </div>
      {searchEverOpened && (
        <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      )}
    </div>
  );
}
