import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  ChevronDown,
  Edit05,
  FilterLines,
  SearchSm,
  User02,
  Users03,
} from "@untitledui/icons";
import { AgentAvatar } from "@/web/components/agent-icon";
import { GlobalSearchDialog } from "./global-search-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import type { Task } from "@/web/components/chat/task/types";
import { useInfiniteScroll } from "@/web/hooks/use-infinite-scroll";
import { TaskRow } from "./task-row";
import { track } from "@/web/lib/posthog-client";
import { writeStoredAutosend } from "@/web/lib/autosend";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker";
import { InstallGitHubMcpDialog } from "@/web/components/install-github-mcp-dialog";
import { AddStorefrontModal } from "@/web/components/add-storefront-modal";
import { SetupSiteMonitoringModal } from "@/web/components/setup-site-monitoring-modal";
import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import {
  type SuggestedAction,
  useSuggestedActions,
} from "./use-suggested-actions";
import {
  type ChecklistItemAction,
  type StudioPackChecklist,
  type StudioPackChecklistItem,
  useStudioPackChecklists,
} from "./use-studio-pack-checklists";

type FilterOption = "all" | "manual" | "automation";
type MemberFilter = "all" | "mine";
type ViewMode = "suggestions" | "all";

const FILTER_LABELS: Record<FilterOption, string> = {
  all: "All tasks",
  manual: "Chats",
  automation: "Automation",
};

const MEMBER_FILTER_LABELS: Record<MemberFilter, string> = {
  all: "All members",
  mine: "Mine only",
};

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  suggestions: "Up next",
  all: "All",
};

export function TasksSection({
  title,
  tasks,
  activeTaskId,
  onSelect,
  onArchive,
  onNew,
  showNewButton,
  showAutomationBadge,
  emptyLabel,
  currentUserId,
  hasMore = false,
  isFetchingMore = false,
  onLoadMore,
}: {
  title: string;
  tasks: Task[];
  activeTaskId: string | null;
  onSelect: (task: Task) => void;
  onArchive: (task: Task) => void;
  onNew?: () => void;
  showNewButton?: boolean;
  showAutomationBadge?: boolean;
  emptyLabel?: string;
  currentUserId?: string;
  hasMore?: boolean;
  isFetchingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastElementRef = useInfiniteScroll(
    () => onLoadMore?.(),
    hasMore,
    isFetchingMore,
    scrollContainerRef,
  );
  const { org } = useProjectContext();
  const [filter, setFilter] = useState<FilterOption>("all");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("mine");
  const [viewMode, setViewMode] = useState<ViewMode>("suggestions");
  const showSuggestions = viewMode === "suggestions";
  const { isLoading: isLoadingSuggestions, suggestions } = useSuggestedActions(
    org.slug,
    { mine: memberFilter === "mine" },
  );
  const { isLoading: isLoadingChecklists, checklists } =
    useStudioPackChecklists(org.slug);
  const navigate = useNavigate();
  const { locator } = useProjectContext();
  const queryClient = useQueryClient();
  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const [installGithubOpen, setInstallGithubOpen] = useState(false);
  const [addStorefrontOpen, setAddStorefrontOpen] = useState(false);
  const [siteMonitoringOpen, setSiteMonitoringOpen] = useState(false);

  const visibleChecklists = checklists.filter((c) =>
    c.items.some((item) => !item.completed),
  );
  const [searchOpen, setSearchOpen] = useState(false);
  // Don't mount the dialog until the user opens it for the first time.
  // GlobalSearchDialog calls `useMCPClient` (Suspense-based) on mount; even
  // though the self-MCP client is currently warm via ThreadManagerProvider,
  // gating on first-open removes the dependency on that invariant.
  const [searchEverOpened, setSearchEverOpened] = useState(false);

  // Scroll the active row into view exactly when `activeTaskId` changes —
  // not when the list grows from infinite scroll. Owning this effect here
  // (instead of inside each row) prevents fetchNextPage re-renders from
  // re-triggering scrollIntoView and fighting the user's scroll position.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- imperative DOM sync keyed on route selection
  useEffect(() => {
    if (!activeTaskId) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(
      `[data-task-id="${CSS.escape(activeTaskId)}"]`,
    );
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTaskId]);

  const memberFiltered =
    memberFilter === "mine" && currentUserId
      ? tasks.filter((t) => t.created_by === currentUserId)
      : tasks;

  const visibleTasks =
    filter === "automation"
      ? memberFiltered.filter((t) => Boolean(t.trigger_id))
      : filter === "manual"
        ? memberFiltered.filter((t) => !t.trigger_id)
        : memberFiltered;

  function handleSuggestionClick(s: SuggestedAction) {
    track("tasks_panel_suggestion_clicked", {
      thread_id: s.thread.id,
      virtual_mcp_id: s.thread.virtual_mcp_id,
    });
    onSelect({
      id: s.thread.id,
      title: s.thread.title ?? "",
      created_at: s.thread.created_at,
      updated_at: s.thread.updated_at,
      virtual_mcp_id: s.thread.virtual_mcp_id ?? undefined,
      trigger_id: s.thread.trigger_id,
      created_by: s.thread.created_by,
    });
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
        // Reuses the storefront picker — the checkbox UI inside owns
        // automation wiring. Future PR can scope this to existing
        // storefronts instead of starting a new import.
        setAddStorefrontOpen(true);
        return;
      case "setup-site-monitoring":
        setSiteMonitoringOpen(true);
        return;
      case "open-agent-thread": {
        // Open the agent's pre-seeded welcome thread
        // (`thrd_welcome_${agentId}`, created by createWelcomeThreadsStep).
        // If the item supplies a prompt, queue it for autosend; otherwise
        // let the agent's state-aware welcome drive the first turn.
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
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 mt-1">
      <div className="shrink-0 pl-2 pr-1.5 h-7 flex items-center justify-between text-xs font-medium text-muted-foreground mb-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Switch view"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 -ml-1.5 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
                  track("tasks_panel_view_mode_changed", { to_value: next });
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
            className="flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
          >
            <SearchSm size={16} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Filter by member"
                className="flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
              >
                {memberFilter === "mine" ? (
                  <User02 size={16} />
                ) : (
                  <Users03 size={16} />
                )}
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
                {(Object.keys(MEMBER_FILTER_LABELS) as MemberFilter[]).map(
                  (opt) => (
                    <DropdownMenuRadioItem key={opt} value={opt}>
                      {MEMBER_FILTER_LABELS[opt]}
                    </DropdownMenuRadioItem>
                  ),
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Filter tasks"
                className={cn(
                  "flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground",
                  filter !== "all" && "text-purple-500",
                )}
              >
                <FilterLines size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={filter}
                onValueChange={(v) => {
                  const next = v as FilterOption;
                  if (next !== filter) {
                    track("tasks_panel_filter_changed", { to_value: next });
                  }
                  setFilter(next);
                }}
              >
                {(Object.keys(FILTER_LABELS) as FilterOption[]).map((opt) => (
                  <DropdownMenuRadioItem key={opt} value={opt}>
                    {FILTER_LABELS[opt]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {showNewButton && onNew && (
            <button
              type="button"
              onClick={() => {
                track("tasks_panel_new_clicked");
                onNew();
              }}
              aria-label={`New ${title.toLowerCase()}`}
              className="flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
            >
              <Edit05 size={16} />
            </button>
          )}
        </div>
      </div>
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-0.5"
      >
        {showSuggestions ? (
          <div className="flex flex-col gap-2 pt-1 px-1 mb-2">
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
                    className={cn(
                      "group/row flex w-full items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left outline-none transition-colors",
                      "hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
                    )}
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
        ) : visibleTasks.length === 0 && emptyLabel ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground/70">
            {emptyLabel}
          </div>
        ) : (
          <>
            {visibleTasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                isActive={activeTaskId === t.id}
                onClick={() => {
                  if (activeTaskId !== t.id) {
                    track("tasks_panel_task_clicked", {
                      thread_id: t.id,
                      virtual_mcp_id: t.virtual_mcp_id ?? null,
                      from_automation: Boolean(t.trigger_id),
                    });
                  }
                  onSelect(t);
                }}
                onArchive={() => {
                  track("tasks_panel_task_archived", {
                    thread_id: t.id,
                    virtual_mcp_id: t.virtual_mcp_id ?? null,
                  });
                  onArchive(t);
                }}
                showAutomationBadge={
                  showAutomationBadge || Boolean(t.trigger_id)
                }
              />
            ))}
            {isFetchingMore && (
              <div className="py-2 text-center text-xs text-muted-foreground">
                Loading more…
              </div>
            )}
            {/* Dedicated sentinel with stable identity. Attaching the
                observer to the last rendered row cascades when client-side
                filters strip out most of each page — the last row keeps
                being in view after every fetch. A fixed sentinel placed
                AFTER the list (and after the loading indicator) only
                intersects when the user has scrolled past the actual
                content. */}
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
          // Picker drove the install (useAutoInstallGitHub). The checklist
          // item flips once the new connection lands — refresh on close so
          // it doesn't wait for window-focus to update.
          if (!open) {
            queryClient.invalidateQueries({
              queryKey: KEYS.studioPackChecklists(org.slug),
            });
          }
        }}
      />
      <InstallGitHubMcpDialog
        open={installGithubOpen}
        onOpenChange={(open) => {
          setInstallGithubOpen(open);
          if (!open) {
            queryClient.invalidateQueries({
              queryKey: KEYS.studioPackChecklists(org.slug),
            });
          }
        }}
      />
      <AddStorefrontModal
        open={addStorefrontOpen}
        onOpenChange={(open) => {
          setAddStorefrontOpen(open);
          if (!open) {
            queryClient.invalidateQueries({
              queryKey: KEYS.studioPackChecklists(org.slug),
            });
          }
        }}
      />
      <SetupSiteMonitoringModal
        open={siteMonitoringOpen}
        onOpenChange={(open) => {
          setSiteMonitoringOpen(open);
          if (!open) {
            queryClient.invalidateQueries({
              queryKey: KEYS.studioPackChecklists(org.slug),
            });
          }
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
