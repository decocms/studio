import { useRef, useState } from "react";
import {
  ChevronDown,
  FilterLines,
  SearchSm,
  User02,
  Users03,
} from "@untitledui/icons";
import { useQueryClient } from "@tanstack/react-query";
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
import { AgentAvatar } from "@/web/components/agent-icon";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker";
import { InstallGitHubMcpDialog } from "@/web/components/install-github-mcp-dialog";
import { AddStorefrontModal } from "@/web/components/add-storefront-modal";
import { SetupSiteMonitoringModal } from "@/web/components/setup-site-monitoring-modal";
import { writeStoredAutosend } from "@/web/lib/autosend";
import { KEYS } from "@/web/lib/query-keys";
import {
  type SuggestedAction,
  useSuggestedActions,
} from "@/web/layouts/tasks-panel/use-suggested-actions";
import {
  type ChecklistItemAction,
  type StudioPackChecklist,
  type StudioPackChecklistItem,
  useStudioPackChecklists,
} from "@/web/layouts/tasks-panel/use-studio-pack-checklists";
import { BrowseAgentsButton } from "../browse-agents-button";
import { CollapsedGroupPopover } from "./collapsed-group-popover";
import { groupThreadsByVirtualMcp } from "./group-threads";
import { stabilizeGroupOrder } from "./stable-order";
import { TaskGroup } from "./task-group";

type TypeFilter = "all" | "manual" | "automation";
type MemberFilter = "all" | "mine";
type ViewMode = "suggestions" | "all";

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: "All tasks",
  manual: "Chats",
  automation: "Automation",
};

const MEMBER_LABELS: Record<MemberFilter, string> = {
  all: "All members",
  mine: "Mine only",
};

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  suggestions: "Up next",
  all: "All",
};

export function TaskGroupsList() {
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const { org, locator } = useProjectContext();
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
  const [viewMode, setViewMode] = useState<ViewMode>("suggestions");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);
  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const [installGithubOpen, setInstallGithubOpen] = useState(false);
  const [addStorefrontOpen, setAddStorefrontOpen] = useState(false);
  const [siteMonitoringOpen, setSiteMonitoringOpen] = useState(false);
  const { state: sidebarState } = useSidebar();
  const queryClient = useQueryClient();

  const { isLoading: isLoadingSuggestions, suggestions } = useSuggestedActions(
    org.slug,
    { mine: memberFilter === "mine" },
  );
  const { isLoading: isLoadingChecklists, checklists } =
    useStudioPackChecklists(org.slug);
  const visibleChecklists = checklists.filter((c) =>
    c.items.some((item) => !item.completed),
  );

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

  function handleSuggestionClick(s: SuggestedAction) {
    track("tasks_panel_suggestion_clicked", {
      thread_id: s.thread.id,
      virtual_mcp_id: s.thread.virtual_mcp_id,
    });
    setTaskId(s.thread.id, s.thread.virtual_mcp_id ?? undefined);
  }

  function handleChecklistItemClick(
    checklist: StudioPackChecklist,
    item: StudioPackChecklistItem,
  ) {
    track("tasks_panel_studio_pack_item_clicked", {
      virtual_mcp_id: checklist.agent.id,
      label: item.label,
      action_kind: item.action.kind,
    });
    dispatchChecklistAction(item.action, checklist.agent.id);
  }

  function dispatchChecklistAction(
    action: ChecklistItemAction,
    agentId: string,
  ) {
    switch (action.kind) {
      case "github-import":
        setGithubPickerOpen(true);
        return;
      case "install-github-mcp":
        setInstallGithubOpen(true);
        return;
      case "add-storefront":
        setAddStorefrontOpen(true);
        return;
      case "configure-github-automations":
        setAddStorefrontOpen(true);
        return;
      case "setup-site-monitoring":
        setSiteMonitoringOpen(true);
        return;
      case "open-agent-thread": {
        const taskId = `thrd_welcome_${agentId}`;
        if (action.prompt) {
          writeStoredAutosend(sessionStorage, locator, taskId, {
            parts: [{ type: "text", text: action.prompt }],
          });
        }
        navigate({
          to: "/$org/$taskId",
          params: { org: org.slug, taskId },
          search: (prev: Record<string, unknown>) => ({
            ...prev,
            virtualmcpid: agentId,
            ...(action.prompt ? { autosend: "true" } : {}),
          }),
        });
        return;
      }
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  function invalidateChecklists() {
    queryClient.invalidateQueries({
      queryKey: KEYS.studioPackChecklists(org.slug),
    });
  }

  const filtersActive = typeFilter !== "all" || memberFilter !== "mine";

  const isCollapsed = sidebarState === "collapsed";

  if (isCollapsed) {
    return (
      <div className="flex flex-col min-h-0 px-1 py-1 gap-1.5 overflow-y-auto">
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
      <div className="shrink-0 pl-2 pr-1 h-7 flex items-center justify-between">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Switch view"
              className="flex items-center gap-1 rounded-md px-1 py-0.5 -ml-1 text-xs font-medium text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 transition-colors"
            >
              <span>{VIEW_MODE_LABELS[viewMode]}</span>
              <ChevronDown size={12} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={viewMode}
              onValueChange={(v) => {
                const next = v as ViewMode;
                if (next !== viewMode) {
                  track("sidebar_view_mode_changed", { to_value: next });
                }
                setViewMode(next);
              }}
            >
              {(Object.keys(VIEW_MODE_LABELS) as ViewMode[]).map((opt) => (
                <DropdownMenuRadioItem key={opt} value={opt}>
                  {VIEW_MODE_LABELS[opt]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Search threads"
            onClick={() => {
              track("tasks_panel_search_opened");
              setSearchEverOpened(true);
              setSearchOpen(true);
            }}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-colors"
          >
            <SearchSm size={14} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Filter tasks"
                className={cn(
                  "flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-colors",
                  filtersActive && "bg-accent text-foreground",
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
          <BrowseAgentsButton compact />
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-0.5"
      >
        {viewMode === "suggestions" ? (
          <div className="flex flex-col gap-2 pt-1 px-1 pb-2">
            {visibleChecklists.map((c) => (
              <ChecklistCard
                key={c.agent.id}
                checklist={c}
                onItemClick={handleChecklistItemClick}
              />
            ))}
            {isLoadingSuggestions || isLoadingChecklists
              ? Array.from({ length: 3 }, (_, i) => (
                  <div
                    key={`suggestion-skeleton-${i}`}
                    className="flex w-full flex-col gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5"
                  >
                    <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                    <div className="h-2.5 w-full animate-pulse rounded bg-muted/70" />
                  </div>
                ))
              : suggestions.map((s) => (
                  <button
                    key={s.thread.id}
                    type="button"
                    onClick={() => handleSuggestionClick(s)}
                    className="group/row flex w-full items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left outline-none transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <AgentAvatar
                      icon={s.icon}
                      name={s.agent?.name ?? s.thread.title ?? "?"}
                      size="xs"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {s.agent && (
                        <div className="w-full truncate text-xs text-muted-foreground">
                          {s.agent.name}
                        </div>
                      )}
                      {s.description && (
                        <div className="line-clamp-2 w-full text-sm font-medium text-foreground">
                          {s.description}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
          </div>
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
      <GitHubRepoPicker
        open={githubPickerOpen}
        onOpenChange={(open) => {
          setGithubPickerOpen(open);
          if (!open) invalidateChecklists();
        }}
      />
      <InstallGitHubMcpDialog
        open={installGithubOpen}
        onOpenChange={(open) => {
          setInstallGithubOpen(open);
          if (!open) invalidateChecklists();
        }}
      />
      <AddStorefrontModal
        open={addStorefrontOpen}
        onOpenChange={(open) => {
          setAddStorefrontOpen(open);
          if (!open) invalidateChecklists();
        }}
      />
      <SetupSiteMonitoringModal
        open={siteMonitoringOpen}
        onOpenChange={(open) => {
          setSiteMonitoringOpen(open);
          if (!open) invalidateChecklists();
        }}
      />
    </div>
  );
}

function ChecklistCard({
  checklist,
  onItemClick,
}: {
  checklist: StudioPackChecklist;
  onItemClick: (
    checklist: StudioPackChecklist,
    item: StudioPackChecklistItem,
  ) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-border bg-background px-3 py-2.5">
      <div className="flex items-center gap-3">
        <AgentAvatar
          icon={checklist.agent.icon}
          name={checklist.agent.name}
          size="xs"
        />
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {checklist.agent.name}
        </div>
      </div>
      <ul className="flex flex-col gap-0.5">
        {checklist.items.map((item, i) => (
          <li key={`${checklist.agent.id}-${i}`}>
            <button
              type="button"
              onClick={() => onItemClick(checklist, item)}
              disabled={item.completed}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-1 py-0.5 text-left text-sm outline-none transition-colors",
                "hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
                item.completed && "cursor-default hover:bg-transparent",
              )}
            >
              <ChecklistCheckbox completed={item.completed} />
              <span
                className={cn(
                  "leading-snug",
                  item.completed
                    ? "text-muted-foreground line-through"
                    : "text-foreground",
                )}
              >
                {item.label}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChecklistCheckbox({ completed }: { completed: boolean }) {
  return completed ? (
    <span
      aria-label="completed"
      className="mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-primary"
    >
      <svg
        viewBox="0 0 10 8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-2 text-primary-foreground"
        style={{ strokeWidth: 2 }}
      >
        <path d="M1 4l2.5 2.5L9 1" />
      </svg>
    </span>
  ) : (
    <span
      aria-label="pending"
      className="mt-0.5 inline-block size-3.5 shrink-0 rounded-sm border-[1.5px] border-muted-foreground/50"
    />
  );
}
