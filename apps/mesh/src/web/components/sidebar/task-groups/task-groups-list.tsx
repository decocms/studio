import { useRef, useState } from "react";
import { FilterLines, SearchSm, User02, Users03 } from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
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
import { CollapsedGroupPopover } from "./collapsed-group-popover";
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
  const { state: sidebarState } = useSidebar();

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
      });
    }
  };

  const handleNewInGroup = (virtualMcpId: string) => {
    track("sidebar_group_new_clicked", { virtual_mcp_id: virtualMcpId });
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

  const filtersActive = typeFilter !== "all" || memberFilter !== "mine";

  const isCollapsed = sidebarState === "collapsed";

  if (isCollapsed) {
    return (
      <div className="flex flex-col min-h-0 px-1 py-1 gap-0.5 overflow-y-auto">
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
