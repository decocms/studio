import { useState, type ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { ScrollFade } from "./scroll-fade";
import {
  Activity,
  Edit05,
  FilterLines,
  Rows01,
  SearchSm,
} from "@untitledui/icons";
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
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
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
import { MyThreadsSection } from "./my-threads-section";
import { SidebarSectionHeader } from "./sidebar-section-header";
import type { SidebarFilters } from "./next-page-offset";
import { buildGroupThreadCounts } from "./next-page-offset";
import { useSidebarGroupOrder } from "./use-sidebar-group-order";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";

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
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
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
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  const isOnHome = pathname === `/${org.slug}` || pathname === `/${org.slug}/`;
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
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);
  const [localOrderRevision, setLocalOrderRevision] = useState(0);
  const contextOrderRevision = useSidebarOrderRevision();
  const orderRevision = localOrderRevision + contextOrderRevision;
  const orderScope = { orgId: org.id, userId: sidebarUserId };

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

  const agentThreadCounts = buildGroupThreadCounts(
    sortedThreads,
    "agent",
    filters,
  );

  // Dev agents are hidden from agent PICKERS (browse popover, @-mention, add
  // to home). Their thread groups are folded into the live counterpart's group
  // so dev sessions stay under one entry instead of a confusing standalone one.
  const orderedGroups = useSidebarGroupOrder(
    orderScope,
    foldDevGroupsIntoLive(
      groupThreadsByVirtualMcp(sortedThreads, decopilotId),
      devToLive,
    ),
    decopilotId,
    orgPinnedIds,
    orderRevision,
  );

  // Groups are built from threads, whose virtual_mcp_id has no FK cascade — so a
  // deleted agent leaves its threads orphaned and would render a ghost "Agent"
  // group. Drop groups whose agent no longer exists in the (delete-invalidated)
  // list. Decopilot (synthetic well-known) and the tool-call-runs bucket are
  // never backed by a listed agent, so they're always kept.
  const knownAgentIds = new Set(
    agents.map((a) => a.id).filter((id): id is string => Boolean(id)),
  );
  const groups = orderedGroups.filter(
    (g) =>
      g.virtualMcpId === decopilotId ||
      g.virtualMcpId === TOOL_CALL_RUNS_GROUP_KEY ||
      knownAgentIds.has(g.virtualMcpId),
  );
  // The Agents section lists real agents only — threads without an agent
  // (tool-call runs) surface in the thread lists, not as an "agent".
  const agentGroups = groups.filter(
    (g) => g.virtualMcpId !== TOOL_CALL_RUNS_GROUP_KEY,
  );

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
  const visibleScopedThreads = showAll ? allThreadsFiltered : myThreads;

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

  const handleNewInGroup = (virtualMcpId: string) => {
    track("sidebar_group_new_clicked", { virtual_mcp_id: virtualMcpId });
    closeAfterNavigation();
    createNewTask(virtualMcpId);
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
    if (candidate) {
      let isEmpty = false;
      try {
        const res = await client.callTool({
          name: "COLLECTION_THREAD_MESSAGES_LIST",
          arguments: { thread_id: candidate.id, limit: 1, offset: 0 },
        });
        const payload = ((res as { structuredContent?: unknown })
          .structuredContent ?? res) as { items?: unknown[] };
        isEmpty = (payload.items?.length ?? 0) === 0;
      } catch {
        // On lookup failure, fall through and create a fresh thread.
      }
      if (isEmpty) {
        closeAfterNavigation();
        setTaskId(candidate.id, currentAgentId);
        return;
      }
    }
    closeAfterNavigation();
    createNewTask(currentAgentId);
  };

  // Click an agent → show the agent home (threads list + new chat input).
  // Decopilot is the product home — clicking it navigates to /$org directly.
  const handleOpenAgent = (virtualMcpId: string) => {
    if (virtualMcpId === decopilotId) {
      closeAfterNavigation();
      navigate({ to: "/$org", params: { org: org.slug } });
      return;
    }
    track("sidebar_agent_opened", { virtual_mcp_id: virtualMcpId });
    closeAfterNavigation();
    navigateToAgent(virtualMcpId);
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
    isActive:
      group.virtualMcpId === decopilotId
        ? isOnHome
        : activeAgentId === group.virtualMcpId,
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

  const scopeToggle = (
    <button
      type="button"
      onClick={() => setShowAll((v) => !v)}
      className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted"
    >
      {showAll ? "All" : "Mine"}
    </button>
  );

  const toolbar = (mobile: boolean) => (
    <div
      className={cn(
        "shrink-0 px-1 flex items-center justify-between",
        mobile ? "h-10" : "h-10 md:h-7 mb-2",
      )}
    >
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
        {!mobile && (
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
        )}
      </div>
      <div className="flex items-center gap-1">
        {scopeToggle}
        <ToolbarIconButton
          aria-label="New thread"
          title="New thread"
          onClick={() => void handleNewThread()}
        >
          <Edit05 size={16} />
        </ToolbarIconButton>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <SyncSidebarAgentGroupsEmpty value={agentGroups.length === 0} />
        {toolbar(true)}
        <Tabs
          defaultValue="threads"
          variant="pill"
          className="flex flex-col flex-1 min-h-0 gap-0"
        >
          <TabsList
            variant="pill"
            className="shrink-0 mx-1 mb-2 w-[calc(100%-0.5rem)]"
          >
            <TabsTrigger variant="pill" value="threads">
              Threads
            </TabsTrigger>
            <TabsTrigger variant="pill" value="agents">
              Agents
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="threads"
            className="flex-1 min-h-0 mt-1 flex flex-col"
          >
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
          </TabsContent>
          <TabsContent
            value="agents"
            className="flex-1 min-h-0 mt-1 flex flex-col"
          >
            <ScrollFade
              wrapperClassName="flex-1 min-h-0"
              className="flex flex-col gap-0.5 overflow-y-auto overscroll-contain px-1 h-full"
            >
              <SortableAgentRows
                groups={agentGroups}
                orderScope={orderScope}
                decopilotId={decopilotId}
                orgPinnedIds={orgPinnedIds}
                onReorder={() => setLocalOrderRevision((n) => n + 1)}
                renderGroup={buildAgentRowProps}
              />
            </ScrollFade>
          </TabsContent>
        </Tabs>
        {searchEverOpened && (
          <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <SyncSidebarAgentGroupsEmpty value={agentGroups.length === 0} />
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
        <div className="shrink-0 mx-2 my-2 border-b" />
        <div className="shrink-0">
          <SidebarSectionHeader
            label="Agents"
            open={agentsOpen}
            onToggle={() => setAgentsOpen((v) => !v)}
            count={agentGroups.length}
            controlsId="sidebar-section-agents"
            actionSlot={<BrowseAgentsButton compact />}
          />
          <div
            id="sidebar-section-agents"
            aria-hidden={!agentsOpen}
            className="grid transition-[grid-template-rows] duration-200 ease-out"
            style={{ gridTemplateRows: agentsOpen ? "1fr" : "0fr" }}
          >
            <div className="overflow-hidden">
              <ScrollFade className="flex flex-col gap-0.5 max-h-[35vh] overflow-y-auto overscroll-contain">
                <SortableAgentRows
                  groups={agentGroups}
                  orderScope={orderScope}
                  decopilotId={decopilotId}
                  orgPinnedIds={orgPinnedIds}
                  onReorder={() => setLocalOrderRevision((n) => n + 1)}
                  renderGroup={buildAgentRowProps}
                />
              </ScrollFade>
            </div>
          </div>
        </div>
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
