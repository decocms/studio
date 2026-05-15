import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  Edit05,
  FilterLines,
  User02,
  Users03,
  XClose,
} from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { toast } from "sonner";
import type { Task } from "@/web/components/chat/task/types";
import { TaskRow } from "./task-row";
import { track } from "@/web/lib/posthog-client";
import { useHomeBoard } from "@/web/components/home/tiles/use-home-board";
import {
  PRESET_DEFAULT_SIZE,
  type PresetTileType,
} from "@/web/components/home/tiles/registry";
import { SIZE_PRESETS } from "@/web/components/home/tiles/constants";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { usePresetTasks, type VisiblePresetTask } from "./use-preset-tasks";

type FilterOption = "all" | "manual" | "automation";
type MemberFilter = "all" | "mine";
type SectionMode = "list" | "new";

const FILTER_LABELS: Record<FilterOption, string> = {
  all: "All tasks",
  manual: "Chats",
  automation: "Automation",
};

const MEMBER_FILTER_LABELS: Record<MemberFilter, string> = {
  all: "All members",
  mine: "Mine only",
};

function newTileId(): string {
  return `tile_${Math.random().toString(36).slice(2, 10)}`;
}

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
}) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { addTile } = useHomeBoard(org.slug);
  const {
    isLoading: isLoadingPresetTasks,
    tasks: visiblePresetTasks,
    dismiss: dismissPresetTask,
    startPreset,
  } = usePresetTasks(org.slug);
  // The BE returns every applicable card; dismissed cards stay in the list
  // with status: "dismissed" until the next refetch — drop them here so
  // the row disappears immediately on the optimistic dismiss.
  const visibleCards = visiblePresetTasks.filter(
    (t) => t.state?.status !== "dismissed",
  );
  const [filter, setFilter] = useState<FilterOption>("all");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("mine");
  // Default per-route: home (no active task) opens the preset cards;
  // inside a chat we open the task list. Manual toggle wins, but only
  // for the current activeTaskId — navigating clears the override so
  // each route gets its default again. Avoids a useEffect for the sync.
  const [override, setOverride] = useState<{
    mode: SectionMode;
    forTask: string | null;
  } | null>(null);
  const defaultMode: SectionMode = activeTaskId ? "list" : "new";
  const mode: SectionMode =
    override && override.forTask === activeTaskId ? override.mode : defaultMode;
  const setMode = (
    next: SectionMode | ((prev: SectionMode) => SectionMode),
  ) => {
    const resolved = typeof next === "function" ? next(mode) : next;
    setOverride({ mode: resolved, forTask: activeTaskId });
  };
  const [importOpen, setImportOpen] = useState(false);
  const [startingPresetId, setStartingPresetId] = useState<string | null>(null);

  const memberFiltered =
    memberFilter === "mine" && currentUserId
      ? tasks.filter((t) => t.created_by === currentUserId)
      : tasks;

  const visibleTasks =
    filter === "automation"
      ? memberFiltered.filter((t) => t.fromAutomation)
      : filter === "manual"
        ? memberFiltered.filter((t) => !t.fromAutomation)
        : memberFiltered;

  function pinPresetTile(
    tileType: PresetTileType,
    taskId: string,
    virtualMcpId: string,
  ) {
    const size = SIZE_PRESETS[PRESET_DEFAULT_SIZE];
    addTile({
      id: newTileId(),
      type: tileType,
      w: size.w,
      h: size.h,
      config: { taskId, virtualMcpId, status: "running" },
    });
  }

  async function handleCardClick(card: VisiblePresetTask) {
    track("tasks_panel_preset_clicked", { preset_id: card.id });
    if (card.action.kind === "new-chat") {
      onNew?.();
      return;
    }
    if (card.action.kind === "import-deco") {
      setImportOpen(true);
      return;
    }
    // kind === "preset": BE creates the task + seeds the first message +
    // starts the agent stream. FE just pins the tile and navigates; the
    // chat page attaches to the running stream via SSE on mount.
    if (startingPresetId) return;
    setStartingPresetId(card.id);
    try {
      const { taskId, tileType, virtualMcpId } = await startPreset(card.id);
      if (tileType) pinPresetTile(tileType, taskId, virtualMcpId);
      navigate({
        to: "/$org/$taskId",
        params: { org: org.slug, taskId },
        search: { virtualmcpid: virtualMcpId },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start";
      toast.error(`Couldn't start "${card.display.title}": ${message}`);
    } finally {
      setStartingPresetId(null);
    }
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
          {showNewButton && (
            <button
              type="button"
              onClick={() => {
                track("tasks_panel_new_clicked");
                setMode((m) => (m === "new" ? "list" : "new"));
              }}
              aria-label={`New ${title.toLowerCase()}`}
              aria-pressed={mode === "new"}
              className={cn(
                "flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground",
                mode === "new" && "bg-muted text-foreground",
              )}
            >
              <Edit05 size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5">
        {mode === "new" ? (
          <div className="flex flex-col gap-2 pt-1 px-1">
            {isLoadingPresetTasks
              ? Array.from({ length: 5 }, (_, i) => (
                  <div
                    key={`preset-skeleton-${i}`}
                    className="flex w-full items-center gap-3.5 rounded-xl border border-border bg-background px-2.5 py-2"
                  >
                    <div className="h-11 w-16 shrink-0 animate-pulse rounded-md bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                    </div>
                  </div>
                ))
              : visibleCards.map((card) => {
                  const isStarting = startingPresetId === card.id;
                  return (
                    // Outer is a div, not a button, so the dismiss `<button>`
                    // can sit inside (no nested-button HTML). Card click +
                    // keyboard activation are wired manually.
                    <div
                      key={card.id}
                      role="button"
                      tabIndex={0}
                      aria-busy={isStarting}
                      aria-disabled={isStarting}
                      onClick={() => {
                        if (isStarting) return;
                        handleCardClick(card);
                      }}
                      onKeyDown={(e) => {
                        if (isStarting) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleCardClick(card);
                        }
                      }}
                      className={cn(
                        "group/row flex w-full cursor-pointer items-center gap-3.5 rounded-xl border border-border bg-background px-2.5 py-2 text-left transition-colors",
                        "hover:border-border hover:bg-accent/40",
                        "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isStarting && "opacity-60 cursor-progress",
                      )}
                    >
                      <div className="relative shrink-0">
                        <img
                          src={card.display.thumb}
                          alt=""
                          aria-hidden
                          className="h-11 w-16 rounded-md object-cover"
                        />
                        {card.display.step !== null && (
                          <span
                            className="absolute -bottom-1 -right-1 flex size-[18px] items-center justify-center rounded-md border border-border bg-background text-[11px] font-semibold leading-none text-foreground"
                            aria-hidden
                          >
                            {card.display.step}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {card.display.title}
                      </div>
                      {card.dismissible && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            track("tasks_panel_preset_dismissed", {
                              preset_id: card.id,
                            });
                            dismissPresetTask(card.id);
                          }}
                          aria-label={`Dismiss ${card.display.title}`}
                          className={cn(
                            "flex size-6 shrink-0 items-center justify-center rounded-md",
                            "text-muted-foreground/70 opacity-0 transition-opacity duration-150",
                            "group-hover/row:opacity-100",
                            "hover:bg-muted hover:text-foreground",
                          )}
                        >
                          <XClose size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
          </div>
        ) : visibleTasks.length === 0 && emptyLabel ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground/70">
            {emptyLabel}
          </div>
        ) : (
          visibleTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              isActive={activeTaskId === t.id}
              onClick={() => {
                if (activeTaskId !== t.id) {
                  track("tasks_panel_task_clicked", {
                    thread_id: t.id,
                    virtual_mcp_id: t.virtual_mcp_id ?? null,
                    from_automation: Boolean(t.fromAutomation),
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
              showAutomationBadge={showAutomationBadge || t.fromAutomation}
            />
          ))
        )}
      </div>
      <ImportFromDecoDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
