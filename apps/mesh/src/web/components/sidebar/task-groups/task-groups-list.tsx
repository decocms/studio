import { useState, type ReactNode } from "react";
import { Activity, FilterLines, Rows01, SearchSm } from "@untitledui/icons";
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
import { SidebarMenu, useSidebar } from "@deco/ui/components/sidebar.tsx";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { useNavigate, useParams } from "@tanstack/react-router";
import { authClient } from "@/web/lib/auth-client";
import {
  useThreadActions,
  useThreads,
} from "@/web/components/chat/store/hooks";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { GlobalSearchDialog } from "@/web/layouts/tasks-panel/global-search-dialog";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";
import {
  getServerPinnedIds,
  useNavigateToAgent,
} from "@/web/hooks/use-navigate-to-agent";
import { useCanPinAgentsForOrg } from "@/web/hooks/use-can-pin-agents-for-org";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { BrowseAgentsButton } from "../browse-agents-button";
import {
  SyncSidebarAgentGroupsEmpty,
  useSidebarOrderRevision,
} from "../sidebar-agent-groups-context";
import { SortableCollapsedTaskGroups } from "./sortable-collapsed-task-groups";
import {
  foldDevGroupsIntoLive,
  groupThreadsByVirtualMcp,
  TOOL_CALL_RUNS_GROUP_KEY,
} from "./group-threads";
import { getLiveDevAgentMaps } from "@/web/lib/agent-capabilities";
import { removeGroupFromOrder, syncOrdersOnOrgPinToggle } from "./stable-order";
import { SortableAgentRows } from "./sortable-agent-rows";
import type { AgentRowProps } from "./agent-row";
import { TeamThreadsSection } from "./team-threads-section";
import { MyThreadsSection } from "./my-threads-section";
import { SidebarSectionHeader } from "./sidebar-section-header";
import type { SidebarFilters } from "./next-page-offset";
import { buildGroupThreadCounts } from "./next-page-offset";
import { useSidebarGroupOrder } from "./use-sidebar-group-order";

type TypeFilter = "all" | "manual" | "automation";
type GroupBy = "flat" | "status";

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: "All tasks",
  manual: "Chats",
  automation: "Automation",
};

export function TaskGroupsList({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}) {
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const sidebarUserId = currentUserId ?? "anon";
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const agents = useVirtualMCPs();
  const { liveToDev, devToLive } = getLiveDevAgentMaps(agents);
  const serverOrgPinnedIds = getServerPinnedIds(agents);
  const canManageOrgPin = useCanPinAgentsForOrg();
  const virtualMcpActions = useVirtualMCPActions();

  const [orgPinOverrides, setOrgPinOverrides] = useState<
    Record<string, boolean>
  >({});
  const serverOrgPinnedSet = new Set(serverOrgPinnedIds);

  // Partition overrides into active (server hasn't confirmed yet) vs confirmed.
  // Confirmed entries are pruned from state so they can't reactivate if server
  // data fluctuates (cache miss, background refetch, etc.).
  const activeOverrides: Record<string, boolean> = {};
  const confirmedKeys: string[] = [];
  for (const [id, pinned] of Object.entries(orgPinOverrides)) {
    if (serverOrgPinnedSet.has(id) !== pinned) {
      activeOverrides[id] = pinned;
    } else {
      confirmedKeys.push(id);
    }
  }
  if (confirmedKeys.length > 0) {
    setOrgPinOverrides((prev) => {
      const next = { ...prev };
      for (const k of confirmedKeys) delete next[k];
      return next;
    });
  }
  const orgPinnedIds = (() => {
    const set = new Set(serverOrgPinnedIds);
    for (const [id, pinned] of Object.entries(activeOverrides)) {
      if (pinned) set.add(id);
      else set.delete(id);
    }
    return [...set];
  })();
  const orgPinnedSet = new Set(orgPinnedIds);

  const {
    threads: allThreads,
    hasMore,
    isFetchingMore,
    fetchNextPage,
  } = useThreads();
  const visibleThreads = allThreads.filter((thread) => !thread.hidden);
  const { hide } = useThreadActions();

  const navigate = useNavigate();
  const navigateToAgent = useNavigateToAgent();
  const { setTaskId, createNewTask } = usePanelActions();
  const params = useParams({ strict: false }) as {
    taskId?: string;
  };
  const activeTaskId = params.taskId ?? null;
  const activeAgentId =
    allThreads.find((t) => t.id === activeTaskId)?.virtual_mcp_id ?? null;
  const closeAfterNavigation = () => {
    onNavigate?.();
  };

  const sortedThreads = [...visibleThreads].sort((a, b) =>
    (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  );

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("flat");
  const [myThreadsOpen, setMyThreadsOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);
  const [localOrderRevision, setLocalOrderRevision] = useState(0);
  const contextOrderRevision = useSidebarOrderRevision();
  const orderRevision = localOrderRevision + contextOrderRevision;
  const orderScope = { orgId: org.id, userId: sidebarUserId };

  // Member scope is now structural (Team vs My sections), so per-group/per-status
  // server pagination stays scoped to the current user via `member: "mine"`.
  const filters: SidebarFilters = {
    type: typeFilter,
    member: "mine",
    currentUserId: currentUserId ?? null,
  };

  const agentThreadCounts = buildGroupThreadCounts(
    sortedThreads,
    "agent",
    filters,
  );

  // Dev agents are hidden from agent PICKERS (browse popover, @-mention, add
  // to home). Their thread groups are folded into the live counterpart's group
  // so dev sessions stay under one entry instead of a confusing standalone one.
  const groups = useSidebarGroupOrder(
    orderScope,
    foldDevGroupsIntoLive(
      groupThreadsByVirtualMcp(sortedThreads, decopilotId),
      devToLive,
    ),
    decopilotId,
    orgPinnedIds,
    orderRevision,
  );
  // The Agents section lists real agents only — threads without an agent
  // (tool-call runs) surface in the thread lists, not as an "agent".
  const agentGroups = groups.filter(
    (g) => g.virtualMcpId !== TOOL_CALL_RUNS_GROUP_KEY,
  );

  const mineFiltered = (threads: Task[]) =>
    currentUserId
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

  // Mine, in recency order — used both for display and to resolve an agent's
  // most-recent thread on click (ignores the type filter so the agent always
  // opens its latest thread).
  const myThreadsAll = mineFiltered(sortedThreads);
  const myThreads = typeFiltered(myThreadsAll);
  const teamThreads = typeFiltered(
    sortedThreads.filter((t) => t.created_by && t.created_by !== currentUserId),
  );

  const handleArchive = (task: Task) => {
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

  const handleNewInGroup = (virtualMcpId: string) => {
    track("sidebar_group_new_clicked", { virtual_mcp_id: virtualMcpId });
    closeAfterNavigation();
    createNewTask(virtualMcpId);
  };

  // Click an agent → open its most recent thread; if it has none, start a new
  // one (which also adds it to the personal sidebar order).
  const handleOpenAgent = (virtualMcpId: string) => {
    const last = myThreadsAll.find((t) => t.virtual_mcp_id === virtualMcpId);
    track("sidebar_agent_opened", {
      virtual_mcp_id: virtualMcpId,
      had_thread: Boolean(last),
    });
    closeAfterNavigation();
    if (last) {
      setTaskId(last.id, virtualMcpId);
    } else {
      navigateToAgent(virtualMcpId);
    }
  };

  const handleShowSettings = (virtualMcpId: string) => {
    track("sidebar_group_settings_clicked", { virtual_mcp_id: virtualMcpId });
    closeAfterNavigation();
    navigateToAgent(virtualMcpId, { search: { main: "instructions" } });
  };

  const handleHideGroup = (virtualMcpId: string) => {
    if (orgPinnedSet.has(virtualMcpId)) return;
    track("sidebar_group_hide_clicked", { virtual_mcp_id: virtualMcpId });
    const group = groups.find((g) => g.virtualMcpId === virtualMcpId);
    if (group) {
      for (const t of group.threads) hide(t.id);
    }
    removeGroupFromOrder(orderScope, virtualMcpId, orgPinnedIds);
    setLocalOrderRevision((n) => n + 1);
  };

  const handleToggleOrgPin = async (virtualMcpId: string, pinned: boolean) => {
    if (!canManageOrgPin) return;
    if (activeOverrides[virtualMcpId] !== undefined) return;
    track("sidebar_group_org_pin_toggled", {
      virtual_mcp_id: virtualMcpId,
      pinned,
    });
    setOrgPinOverrides((prev) => ({ ...prev, [virtualMcpId]: pinned }));
    try {
      await virtualMcpActions.update.mutateAsync({
        id: virtualMcpId,
        data: { pinned },
      });
      // The override is pruned from state automatically on the next render once
      // serverOrgPinnedIds reflects the change — no explicit cleanup needed here.
    } catch {
      syncOrdersOnOrgPinToggle(orderScope, virtualMcpId, !pinned);
      setOrgPinOverrides((prev) => {
        const next = { ...prev };
        delete next[virtualMcpId];
        return next;
      });
    }
  };

  const groupContextMenuProps = (virtualMcpId: string) => {
    const isNonAgentGroup =
      virtualMcpId === decopilotId || virtualMcpId === TOOL_CALL_RUNS_GROUP_KEY;
    return {
      isOrgPinned: isNonAgentGroup || orgPinnedSet.has(virtualMcpId),
      canManageOrgPin: isNonAgentGroup ? false : canManageOrgPin,
      onToggleOrgPin: isNonAgentGroup ? undefined : handleToggleOrgPin,
    };
  };

  const buildAgentRowProps = (
    group: (typeof agentGroups)[number],
  ): AgentRowProps => ({
    virtualMcpId: group.virtualMcpId,
    isActive: activeAgentId === group.virtualMcpId,
    threadCount: agentThreadCounts.get(group.virtualMcpId) ?? 0,
    onOpen: handleOpenAgent,
    onNewTask: handleNewInGroup,
    onShowSettings: handleShowSettings,
    onHideGroup: handleHideGroup,
    ...groupContextMenuProps(group.virtualMcpId),
  });

  // The collapsed rail still renders per-agent thread popovers, so it keeps the
  // richer group-render props (with nested, mine-scoped threads).
  const buildCollapsedGroupProps = (group: (typeof groups)[number]) => {
    const filtered = typeFiltered(mineFiltered(group.threads));
    const devPartnerId = liveToDev.get(group.virtualMcpId) ?? null;
    return {
      virtualMcpId: group.virtualMcpId,
      threads: filtered,
      devPartnerId,
      devGroupVisibleCount: devPartnerId
        ? (agentThreadCounts.get(devPartnerId) ?? 0)
        : 0,
      activeTaskId,
      filters,
      groupVisibleCount: agentThreadCounts.get(group.virtualMcpId) ?? 0,
      onSelectTask: handleSelectTask,
      onArchiveTask: handleArchive,
      onNewTaskInGroup: handleNewInGroup,
      onShowSettings: handleShowSettings,
      onHideGroup: handleHideGroup,
      ...groupContextMenuProps(group.virtualMcpId),
    };
  };

  const filtersActive = typeFilter !== "all";
  const { state: sidebarState, isMobile } = useSidebar();

  const isCollapsed = sidebarState === "collapsed" && !isMobile;

  if (isCollapsed) {
    const visibleGroups = groups.filter((group) => {
      const filtered = typeFiltered(mineFiltered(group.threads));
      return !(filtersActive && filtered.length === 0);
    });

    return (
      <>
        <SyncSidebarAgentGroupsEmpty value={agentGroups.length === 0} />
        <SidebarMenu className="min-h-0 gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SortableCollapsedTaskGroups
            groups={visibleGroups}
            orderScope={orderScope}
            decopilotId={decopilotId}
            orgPinnedIds={orgPinnedIds}
            onReorder={() => setLocalOrderRevision((n) => n + 1)}
            renderGroup={(group) => buildCollapsedGroupProps(group)}
          />
        </SidebarMenu>
      </>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <SyncSidebarAgentGroupsEmpty value={agentGroups.length === 0} />
      <div className="shrink-0 px-1 h-10 md:h-7 mb-2 flex items-center justify-between">
        <div className="flex items-center gap-0.5">
          <ToolbarIconButton
            aria-label="Search threads"
            onClick={() => {
              track("tasks_panel_search_opened");
              setSearchEverOpened(true);
              setSearchOpen(true);
            }}
          >
            <SearchSm size={16} />
          </ToolbarIconButton>
          <ToolbarIconButton
            aria-label={
              groupBy === "flat" ? "Group by status" : "Show as flat list"
            }
            title={groupBy === "flat" ? "Flat list" : "Grouped by status"}
            onClick={() => {
              const next: GroupBy = groupBy === "flat" ? "status" : "flat";
              track("tasks_panel_group_by_changed", { to_value: next });
              setGroupBy(next);
            }}
          >
            {groupBy === "flat" ? <Rows01 size={16} /> : <Activity size={16} />}
          </ToolbarIconButton>
          <Popover>
            <PopoverTrigger asChild>
              <ToolbarIconButton aria-label="Filter tasks">
                <FilterLines size={16} />
                {filtersActive && (
                  <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-red-500 ring-1 ring-sidebar pointer-events-none" />
                )}
              </ToolbarIconButton>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={8}
              collisionPadding={16}
              className="w-72 p-3"
            >
              <div className="flex flex-col gap-2">
                <FilterRow label="Type">
                  <Select
                    value={typeFilter}
                    onValueChange={(v) => {
                      const next = v as TypeFilter;
                      if (next !== typeFilter) {
                        track("tasks_panel_filter_changed", {
                          to_value: next,
                        });
                      }
                      setTypeFilter(next);
                    }}
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TYPE_LABELS) as TypeFilter[]).map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {TYPE_LABELS[opt]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FilterRow>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <BrowseAgentsButton compact />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-0.5 -mr-2 pr-2">
        <TeamThreadsSection
          threads={teamThreads}
          activeTaskId={activeTaskId}
          onSelectTask={handleSelectTask}
          onNavigate={closeAfterNavigation}
        />
        <SidebarSectionHeader
          label="My threads"
          open={myThreadsOpen}
          onToggle={() => setMyThreadsOpen((v) => !v)}
          count={myThreads.length}
        />
        {myThreadsOpen && (
          <MyThreadsSection
            threads={myThreads}
            groupBy={groupBy}
            activeTaskId={activeTaskId}
            onSelectTask={handleSelectTask}
            onArchiveTask={handleArchive}
            filters={filters}
            hasMore={hasMore}
            isFetchingMore={isFetchingMore}
            onLoadMore={() => void fetchNextPage()}
          />
        )}
        <div className="mx-2 my-2 border-b" />
        <SidebarSectionHeader
          label="Agents"
          open={agentsOpen}
          onToggle={() => setAgentsOpen((v) => !v)}
          count={agentGroups.length}
        />
        {agentsOpen && (
          <SortableAgentRows
            groups={agentGroups}
            orderScope={orderScope}
            decopilotId={decopilotId}
            orgPinnedIds={orgPinnedIds}
            onReorder={() => setLocalOrderRevision((n) => n + 1)}
            renderGroup={buildAgentRowProps}
          />
        )}
      </div>
      {searchEverOpened && (
        <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      )}
    </div>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="w-36 shrink-0">{children}</div>
    </div>
  );
}
