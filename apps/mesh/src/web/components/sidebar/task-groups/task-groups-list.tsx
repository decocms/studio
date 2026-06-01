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
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;

  const { threads: allThreads } = useThreads();
  const agents = useVirtualMCPs();
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
  const [groupBy, setGroupBy] = useState<GroupBy>("agent");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);
  const [hiddenState, setHiddenState] = useState<{
    orgId: string;
    ids: Set<string>;
  }>(() => {
    try {
      const raw = localStorage.getItem(`studio:hidden-agents:${org.id}`);
      return {
        orgId: org.id,
        ids: new Set<string>(raw ? JSON.parse(raw) : []),
      };
    } catch {
      return { orgId: org.id, ids: new Set<string>() };
    }
  });
  if (hiddenState.orgId !== org.id) {
    try {
      const raw = localStorage.getItem(`studio:hidden-agents:${org.id}`);
      setHiddenState({
        orgId: org.id,
        ids: new Set<string>(raw ? JSON.parse(raw) : []),
      });
    } catch {
      setHiddenState({ orgId: org.id, ids: new Set<string>() });
    }
  }
  const hiddenAgentIds = hiddenState.ids;
  const { state: sidebarState, isMobile } = useSidebar();

  const groups = stabilizeGroupOrder(
    org.id,
    groupThreadsByVirtualMcp(sortedThreads, agents, decopilotId),
    decopilotId,
  ).filter((g) => g.threads.length > 0 || !hiddenAgentIds.has(g.virtualMcpId));

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
      });
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
    track("sidebar_group_hide_clicked", { virtual_mcp_id: virtualMcpId });
    const group = groups.find((g) => g.virtualMcpId === virtualMcpId);
    if (group) {
      for (const t of group.threads) hide(t.id);
    }
    setHiddenState((prev) => {
      const next = new Set(prev.ids);
      next.add(virtualMcpId);
      try {
        localStorage.setItem(
          `studio:hidden-agents:${org.id}`,
          JSON.stringify([...next]),
        );
      } catch {}
      return { ...prev, ids: next };
    });
  };

  const filtersActive = typeFilter !== "all" || memberFilter !== "mine";

  // On mobile the sidebar renders inside a full-width drawer that is always
  // visually expanded (the wrapper hardcodes data-state="expanded"). The context
  // `state` stays "collapsed" on mobile because the drawer toggles `openMobile`,
  // not `open` — so without this guard the agent groups would render icon-only
  // and hide their names. Mirror the wrapper: never collapse on mobile.
  const isCollapsed = sidebarState === "collapsed" && !isMobile;

  const filters: SidebarFilters = {
    type: typeFilter,
    member: memberFilter,
    currentUserId: currentUserId ?? null,
  };

  if (isCollapsed) {
    return (
      <SidebarMenu className="min-h-0 gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {groups.map((group) => {
          const filtered = typeFiltered(memberFiltered(group.threads));
          const dimmed = filtersActive && filtered.length === 0;
          if (dimmed) return null;
          return (
            <CollapsedGroupPopover
              key={group.virtualMcpId}
              virtualMcpId={group.virtualMcpId}
              threads={filtered}
              activeTaskId={activeTaskId}
              filters={filters}
              onSelectTask={(t) => setTaskId(t.id, t.virtual_mcp_id)}
              onArchiveTask={handleArchive}
              onNewTaskInGroup={handleNewInGroup}
              onShowSettings={handleShowSettings}
              onHideGroup={handleHideGroup}
            />
          );
        })}
      </SidebarMenu>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
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
              <ToolbarIconButton
                aria-label="Filter tasks"
                active={filtersActive}
              >
                <FilterLines size={16} />
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
          <>
            {groups.map((group) => {
              const filtered = typeFiltered(memberFiltered(group.threads));
              const dimmed = filtersActive && filtered.length === 0;
              return (
                <TaskGroup
                  key={group.virtualMcpId}
                  virtualMcpId={group.virtualMcpId}
                  threads={filtered}
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
          </>
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
