import { useEffect, useRef, useState } from "react";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Edit05, FilterLines, User02, Users03 } from "@untitledui/icons";
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
import {
  type SuggestedAction,
  useSuggestedActions,
} from "./use-suggested-actions";

type FilterOption = "all" | "manual" | "automation";
type MemberFilter = "all" | "mine";

const FILTER_LABELS: Record<FilterOption, string> = {
  all: "All tasks",
  manual: "Chats",
  automation: "Automation",
};

const MEMBER_FILTER_LABELS: Record<MemberFilter, string> = {
  all: "All members",
  mine: "Mine only",
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
  const showSuggestions = !activeTaskId;
  const { isLoading: isLoadingSuggestions, suggestions } = useSuggestedActions(
    org.slug,
    { mine: memberFilter === "mine" },
  );

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

  return (
    <div className="flex flex-col h-full min-h-0 mt-1">
      <div className="shrink-0 pl-2 pr-1.5 h-7 flex items-center justify-between text-xs font-medium text-muted-foreground mb-1">
        <span>{title}</span>
        <div className="flex items-center gap-0.5">
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
            {isLoadingSuggestions
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
                      "group/row flex w-full flex-col items-start gap-1 rounded-xl border border-border bg-background px-3 py-2.5 text-left outline-none transition-colors",
                      "hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
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
    </div>
  );
}
