import { useRef, useState } from "react";
import {
  FilterLines,
  LayoutAlt04,
  MessageCircle01,
  SearchSm,
  User01,
  Zap,
} from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
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

type TypeFilter = "all" | "manual" | "automation";
type MemberFilter = "all" | "mine";
type GroupBy = "agent" | "status";

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: "All types",
  manual: "Chats only",
  automation: "Automation only",
};

const TYPE_CYCLE: Record<TypeFilter, TypeFilter> = {
  all: "manual",
  manual: "automation",
  automation: "all",
};

const TYPE_ICONS: Record<TypeFilter, typeof FilterLines> = {
  all: FilterLines,
  manual: MessageCircle01,
  automation: Zap,
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
  const [groupBy, setGroupBy] = useState<GroupBy>("agent");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);
  const { state: sidebarState } = useSidebar();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastElementRef = useInfiniteScroll(
    () => fetchNextPage(),
    hasMore,
    isFetchingMore,
    scrollRef,
  );

  const groups = stabilizeGroupOrder(
    org.id,
    groupThreadsByVirtualMcp(sortedThreads, decopilotId),
    decopilotId,
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
    if (!group) return;
    for (const t of group.threads) hide(t.id);
  };

  const filtersActive = typeFilter !== "all" || memberFilter !== "mine";

  const isCollapsed = sidebarState === "collapsed";

  if (isCollapsed) {
    return (
      <div className="flex flex-col min-h-0 gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
              onSelectTask={(t) => setTaskId(t.id, t.virtual_mcp_id)}
              onArchiveTask={handleArchive}
              onNewTaskInGroup={handleNewInGroup}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-1 h-10 md:h-7 flex items-center justify-between">
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
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
            </TooltipTrigger>
            <TooltipContent side="bottom">Search threads</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToolbarIconButton
                aria-label={
                  groupBy === "status" ? "Group by agent" : "Group by status"
                }
                aria-pressed={groupBy === "status"}
                active={groupBy === "status"}
                onClick={() => {
                  const next: GroupBy =
                    groupBy === "status" ? "agent" : "status";
                  track("tasks_panel_group_by_changed", { to_value: next });
                  setGroupBy(next);
                }}
              >
                <LayoutAlt04 size={16} />
              </ToolbarIconButton>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {groupBy === "status" ? "Grouped by status" : "Grouped by agent"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToolbarIconButton
                aria-label={
                  memberFilter === "mine"
                    ? "Show all members"
                    : "Show mine only"
                }
                aria-pressed={memberFilter === "mine"}
                active={memberFilter === "mine"}
                onClick={() => {
                  const next: MemberFilter =
                    memberFilter === "mine" ? "all" : "mine";
                  track("tasks_panel_member_filter_changed", {
                    to_value: next,
                  });
                  setMemberFilter(next);
                }}
              >
                <User01 size={16} />
              </ToolbarIconButton>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {memberFilter === "mine" ? "Mine only" : "All members"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToolbarIconButton
                aria-label={`Type: ${TYPE_LABELS[typeFilter]}`}
                aria-pressed={typeFilter !== "all"}
                active={typeFilter !== "all"}
                onClick={() => {
                  const next = TYPE_CYCLE[typeFilter];
                  track("tasks_panel_filter_changed", { to_value: next });
                  setTypeFilter(next);
                }}
              >
                {(() => {
                  const Icon = TYPE_ICONS[typeFilter];
                  return <Icon size={16} />;
                })()}
              </ToolbarIconButton>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {TYPE_LABELS[typeFilter]}
            </TooltipContent>
          </Tooltip>
        </div>
        <BrowseAgentsButton compact />
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-0.5 -mr-2 pr-2"
      >
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
              />
            ))}
            {isFetchingMore && (
              <div className="py-2 text-center text-xs text-muted-foreground">
                Loading more…
              </div>
            )}
            {hasMore && <div ref={lastElementRef} aria-hidden />}
          </>
        ) : (
          <>
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
                />
              );
            })}
            {isFetchingMore && (
              <div className="py-2 text-center text-xs text-muted-foreground">
                Loading more…
              </div>
            )}
            {hasMore && <div ref={lastElementRef} aria-hidden />}
          </>
        )}
      </div>
      {searchEverOpened && (
        <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      )}
    </div>
  );
}
