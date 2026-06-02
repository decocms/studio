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
import { filterThreads } from "@/web/components/chat/task";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { GlobalSearchDialog } from "@/web/layouts/tasks-panel/global-search-dialog";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { useCanPinAgentsForOrg } from "@/web/hooks/use-can-pin-agents-for-org";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { BrowseAgentsButton } from "../browse-agents-button";
import {
  SyncSidebarAgentGroupsEmpty,
  useSidebarOrderRevision,
} from "../sidebar-agent-groups-context";
import { SortableCollapsedTaskGroups } from "./sortable-collapsed-task-groups";
import {
  groupThreadsByVirtualMcp,
  groupThreadsByStatus,
  TOOL_CALL_RUNS_GROUP_KEY,
} from "./group-threads";
import { removeGroupFromOrder, syncOrdersOnOrgPinToggle } from "./stable-order";
import { SortableTaskGroups } from "./sortable-task-groups";
import { StatusGroup } from "./task-group";
import type { SidebarFilters } from "./next-page-offset";
import { buildGroupThreadCounts } from "./next-page-offset";
import { useSidebarGroupOrder } from "./use-sidebar-group-order";

type TypeFilter = "all" | "manual" | "automation";
type MemberFilter = "all" | "mine";
type GroupBy = "agent" | "status";

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: "All tasks",
  manual: "Chats",
  automation: "Automation",
};

const MEMBER_LABELS: Record<MemberFilter, string> = {
  all: "All members",
  mine: "Mine only",
};

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  agent: "Agent",
  status: "Status",
};

export function TaskGroupsList() {
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const sidebarUserId = currentUserId ?? "anon";
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const agents = useVirtualMCPs();
  const serverOrgPinnedIds = agents.filter((a) => a.pinned).map((a) => a.id);
  const canManageOrgPin = useCanPinAgentsForOrg();
  const virtualMcpActions = useVirtualMCPActions();

  const [orgPinOverrides, setOrgPinOverrides] = useState<
    Record<string, boolean>
  >({});
  const serverOrgPinnedSet = new Set(serverOrgPinnedIds);
  // Only keep overrides that haven't been confirmed by server data yet.
  // This prevents the group from jumping back when the override is cleared
  // before the React Query re-fetch completes.
  const activeOverrides = Object.fromEntries(
    Object.entries(orgPinOverrides).filter(
      ([id, pinned]) => serverOrgPinnedSet.has(id) !== pinned,
    ),
  );
  const orgPinnedIds = (() => {
    const set = new Set(serverOrgPinnedIds);
    for (const [id, pinned] of Object.entries(activeOverrides)) {
      if (pinned) set.add(id);
      else set.delete(id);
    }
    return [...set];
  })();
  const orgPinnedSet = new Set(orgPinnedIds);

  const { threads: allThreads } = useThreads();
  const visibleThreads = filterThreads(allThreads, { hidden: false });
  const { hide } = useThreadActions();

  const navigate = useNavigate();
  const { setTaskId, createNewTask } = usePanelActions();
  const params = useParams({ strict: false }) as {
    taskId?: string;
  };
  const activeTaskId = params.taskId ?? null;

  const sortedThreads = [...visibleThreads].sort((a, b) =>
    (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  );

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("mine");
  const [groupBy, setGroupBy] = useState<GroupBy>("agent");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);
  const [localOrderRevision, setLocalOrderRevision] = useState(0);
  const contextOrderRevision = useSidebarOrderRevision();
  const orderRevision = localOrderRevision + contextOrderRevision;
  const orderScope = { orgId: org.id, userId: sidebarUserId };

  const filters: SidebarFilters = {
    type: typeFilter,
    member: memberFilter,
    currentUserId: currentUserId ?? null,
  };

  const agentThreadCounts = buildGroupThreadCounts(
    sortedThreads,
    "agent",
    filters,
  );

  const groups = useSidebarGroupOrder(
    orderScope,
    groupThreadsByVirtualMcp(sortedThreads, decopilotId),
    decopilotId,
    orgPinnedIds,
    orderRevision,
  );

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
    const next = sortedThreads.find(
      (t) => t.id !== task.id && t.virtual_mcp_id === task.virtual_mcp_id,
    );
    if (next) {
      setTaskId(next.id, next.virtual_mcp_id);
    } else {
      navigate({ to: "/$org", params: { org: org.slug } });
    }
  };

  const handleNewInGroup = (virtualMcpId: string) => {
    track("sidebar_group_new_clicked", { virtual_mcp_id: virtualMcpId });
    createNewTask(virtualMcpId);
  };

  const navigateToAgent = useNavigateToAgent();
  const handleShowSettings = (virtualMcpId: string) => {
    track("sidebar_group_settings_clicked", { virtual_mcp_id: virtualMcpId });
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
      // Override auto-clears via activeOverrides once serverOrgPinnedIds reflects the change.
      // No explicit cleanup here to avoid the group jumping back while the re-fetch is in flight.
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
      isOrgPinned: orgPinnedSet.has(virtualMcpId),
      canManageOrgPin: isNonAgentGroup ? false : canManageOrgPin,
      onToggleOrgPin: isNonAgentGroup ? undefined : handleToggleOrgPin,
    };
  };

  const buildAgentGroupRenderProps = (group: (typeof groups)[number]) => {
    const filtered = typeFiltered(memberFiltered(group.threads));
    return {
      virtualMcpId: group.virtualMcpId,
      threads: filtered,
      activeTaskId,
      filters,
      groupVisibleCount: agentThreadCounts.get(group.virtualMcpId) ?? 0,
      onSelectTask: (t: Task) => setTaskId(t.id, t.virtual_mcp_id),
      onArchiveTask: handleArchive,
      onNewTaskInGroup: handleNewInGroup,
      onShowSettings: handleShowSettings,
      onHideGroup: handleHideGroup,
      ...groupContextMenuProps(group.virtualMcpId),
    };
  };

  const filtersActive = typeFilter !== "all" || memberFilter !== "mine";
  const { state: sidebarState, isMobile } = useSidebar();

  const isCollapsed = sidebarState === "collapsed" && !isMobile;

  if (isCollapsed) {
    const visibleGroups = groups.filter((group) => {
      const filtered = typeFiltered(memberFiltered(group.threads));
      return !(filtersActive && filtered.length === 0);
    });

    return (
      <>
        <SyncSidebarAgentGroupsEmpty
          value={groupBy === "agent" && groups.length === 0}
        />
        <SidebarMenu className="min-h-0 gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SortableCollapsedTaskGroups
            groups={visibleGroups}
            orderScope={orderScope}
            decopilotId={decopilotId}
            orgPinnedIds={orgPinnedIds}
            onReorder={() => setLocalOrderRevision((n) => n + 1)}
            renderGroup={(group) => buildAgentGroupRenderProps(group)}
          />
        </SidebarMenu>
      </>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <SyncSidebarAgentGroupsEmpty
        value={groupBy === "agent" && groups.length === 0}
      />
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
            aria-label={`Group by ${GROUP_BY_LABELS[groupBy === "agent" ? "status" : "agent"].toLowerCase()}`}
            title={`Grouped by ${GROUP_BY_LABELS[groupBy].toLowerCase()}`}
            onClick={() => {
              const next: GroupBy = groupBy === "agent" ? "status" : "agent";
              track("tasks_panel_group_by_changed", { to_value: next });
              setGroupBy(next);
            }}
          >
            {groupBy === "agent" ? (
              <Users01 size={16} />
            ) : (
              <Activity size={16} />
            )}
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
                <FilterRow label="Members">
                  <Select
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
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(MEMBER_LABELS) as MemberFilter[]).map(
                        (opt) => (
                          <SelectItem key={opt} value={opt}>
                            {MEMBER_LABELS[opt]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </FilterRow>
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
        {groupBy === "status" ? (
          <>
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
          </>
        ) : (
          <SortableTaskGroups
            groups={groups}
            orderScope={orderScope}
            decopilotId={decopilotId}
            orgPinnedIds={orgPinnedIds}
            onReorder={() => setLocalOrderRevision((n) => n + 1)}
            renderGroup={(group) => ({
              ...buildAgentGroupRenderProps(group),
            })}
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
