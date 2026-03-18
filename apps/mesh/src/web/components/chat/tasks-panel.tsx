/**
 * Tasks Panel & Task List Components
 *
 * Shared task list UI used in both:
 * - Home page: persistent TasksPanel sidebar (left side)
 * - Other pages: TaskListContent inside the chat panel overlay
 *
 * Design matches /tasks/ page exactly, just compact in width.
 */

import { useChat } from "@/web/components/chat/index";
import { useChatStable } from "@/web/components/chat/context";

import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { User } from "@/web/components/user/user.tsx";
import { formatTimeAgo } from "@/web/lib/format-time";
import {
  STATUS_ORDER,
  STATUS_CONFIG,
  groupByStatus,
} from "@/web/lib/task-status";
import type { Task } from "./task/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

import {
  Check,
  CheckDone02,
  ChevronRight,
  Edit01,
  Loading01,
  Plus,
} from "@untitledui/icons";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { Suspense, useRef, useState } from "react";
import { ErrorBoundary } from "../error-boundary";
import { User as UserIcon, Users as UsersIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.js";
import { Button } from "@deco/ui/components/button.js";
import type { TaskOwnerFilter } from "./task";

// --- Truncated text with tooltip ---

function TruncatedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(isOpen) => {
        if (isOpen && ref.current) {
          setOpen(ref.current.scrollWidth > ref.current.clientWidth);
        } else {
          setOpen(false);
        }
      }}
    >
      <TooltipTrigger asChild>
        <span ref={ref} className={cn("truncate block", className)}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function TaskOwnerFilter() {
  const { ownerFilter, setOwnerFilter, isFilterChangePending } =
    useChatStable();

  const handleChange = (value: string) => {
    setOwnerFilter(value as TaskOwnerFilter);
  };

  const isFiltered = ownerFilter === "me";
  const Icon = isFilterChangePending
    ? Loading01
    : isFiltered
      ? UserIcon
      : UsersIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="size-8"
          title={isFiltered ? "My tasks" : "All tasks"}
          disabled={isFilterChangePending}
        >
          <Icon
            size={14}
            className={cn(
              isFilterChangePending
                ? "animate-spin text-muted-foreground"
                : isFiltered
                  ? "text-foreground"
                  : "text-muted-foreground",
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Filter by owner</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={ownerFilter}
          onValueChange={handleChange}
        >
          <DropdownMenuRadioItem value="me">My tasks</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="everyone">
            All tasks
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Shared task list content ---

interface TaskListContentProps {
  /** Called when a task is selected (defaults to switchToTask from chat context) */
  onTaskSelect?: (taskId: string) => void;
}

/**
 * TaskListContent - The core task list with search + status-grouped tasks.
 * Uses chat context for both data and active task state.
 * Used in both the home TasksPanel and the chat panel overlay.
 *
 * Design matches the /tasks/ page StatusGroup exactly, just without
 * the description column and wide spacer (compact width).
 */
export function TaskListContent({ onTaskSelect }: TaskListContentProps) {
  const { activeTaskId, switchToTask } = useChat();
  const { renameTask, tasks } = useChatStable();

  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const visible = tasks.filter((t) => !t.hidden);

  const searched = searchQuery.trim()
    ? visible.filter((t) =>
        t.title.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : visible;

  const groups = groupByStatus(searched);
  const activeStatuses = STATUS_ORDER.filter(
    (s) => groups[s] && groups[s].length > 0,
  );

  const toggleGroup = (status: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [status]: !prev[status] }));
  };

  const handleTaskClick = async (task: Task) => {
    if (onTaskSelect) {
      onTaskSelect(task.id);
    } else {
      await switchToTask(task.id);
    }
  };

  const startEditing = (task: Task, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingTaskId(task.id);
    setEditingTitle(task.title || "");
  };

  const commitEdit = async (taskId: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed) {
      await renameTask(taskId, trimmed);
    }
    setEditingTaskId(null);
  };

  const handleEditKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    taskId: string,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit(taskId);
    } else if (e.key === "Escape") {
      setEditingTaskId(null);
    }
  };

  return (
    <>
      <div className="relative">
        <CollectionSearch
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search tasks..."
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearchQuery("");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2">
          <TaskOwnerFilter />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col">
        {searched.length === 0 ? (
          <EmptyState
            image={<CheckDone02 size={48} className="text-muted-foreground" />}
            title={searchQuery ? "No tasks found" : "No tasks yet"}
            description={
              searchQuery
                ? `No tasks match "${searchQuery}"`
                : "Tasks will appear here as you start working."
            }
          />
        ) : (
          activeStatuses.map((status, idx) => {
            const config = STATUS_CONFIG[status];
            if (!config) return null;
            const Icon = config.icon;
            const statusTasks = groups[status] ?? [];
            const isOpen = !collapsedGroups[status];

            return (
              <div key={status} className="flex flex-col">
                {/* Group header */}
                <button
                  type="button"
                  onClick={() => toggleGroup(status)}
                  className={cn(
                    "flex items-center w-full bg-[rgba(245,245,245,0.3)] border-b border-border/50 dark:bg-[rgba(30,30,30,0.3)]",
                    idx !== 0 && "border-t border-border/50",
                  )}
                >
                  <div className="flex items-center justify-center w-9 shrink-0 px-3">
                    <ChevronRight
                      size={16}
                      className={cn(
                        "text-muted-foreground transition-transform duration-200",
                        isOpen && "rotate-90",
                      )}
                    />
                  </div>
                  <div className="flex items-center gap-3 flex-1 py-3">
                    <Icon size={16} className={config.iconClassName} />
                    <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">
                      {config.label}
                    </span>
                    <span className="text-xs text-muted-foreground/60">
                      {statusTasks.length}
                    </span>
                  </div>
                </button>

                {/* Task rows */}
                {isOpen &&
                  statusTasks.map((task) => {
                    const isActive = task.id === activeTaskId;
                    const isEditing = editingTaskId === task.id;
                    return (
                      <div
                        key={task.id}
                        className={cn(
                          "group flex items-center w-full hover:bg-accent/50 transition-colors cursor-pointer",
                          isActive && "bg-accent/50",
                        )}
                        onClick={() => !isEditing && handleTaskClick(task)}
                      >
                        <div className="flex items-center gap-3 min-w-0 py-3 pl-4 flex-1">
                          <Icon
                            size={16}
                            className={cn("shrink-0", config.iconClassName)}
                          />
                          {isEditing ? (
                            <div
                              className="flex items-center gap-1 flex-1 min-w-0 pr-3"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                autoFocus
                                value={editingTitle}
                                onChange={(e) =>
                                  setEditingTitle(e.target.value)
                                }
                                onBlur={() => commitEdit(task.id)}
                                onKeyDown={(e) => handleEditKeyDown(e, task.id)}
                                className="flex-1 text-sm bg-transparent border-b border-foreground/30 focus:border-foreground outline-none pb-0.5 min-w-0"
                              />
                              <button
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => commitEdit(task.id)}
                                className="p-1 hover:bg-accent rounded shrink-0"
                              >
                                <Check
                                  size={12}
                                  className="text-muted-foreground"
                                />
                              </button>
                            </div>
                          ) : (
                            <TruncatedText
                              text={task.title || "Untitled"}
                              className="text-sm font-medium text-foreground flex-1 min-w-0"
                            />
                          )}
                        </div>
                        {!isEditing && (
                          <>
                            <div className="flex items-center gap-1 px-2 shrink-0">
                              <button
                                type="button"
                                onClick={(e) => startEditing(task, e)}
                                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-accent rounded transition-opacity"
                                title="Rename task"
                              >
                                <Edit01
                                  size={13}
                                  className="text-muted-foreground"
                                />
                              </button>
                              {task.created_by && (
                                <User
                                  id={task.created_by}
                                  size="3xs"
                                  avatarOnly
                                />
                              )}
                            </div>
                            <div className="w-20 p-3 shrink-0 text-right">
                              <span className="text-sm text-muted-foreground whitespace-nowrap">
                                {task.updated_at
                                  ? formatTimeAgo(new Date(task.updated_at))
                                  : "\u2014"}
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// --- Home page panel wrapper ---

function TasksPanelContent() {
  const { createTask, isChatEmpty } = useChat();

  return (
    <div className="flex flex-col h-full bg-background border-r border-border/50">
      {/* Header */}
      <div className="h-11 px-4 flex items-center justify-between shrink-0 border-b border-border/50">
        <span className="text-sm font-normal text-foreground">Tasks</span>
        <button
          type="button"
          onClick={() => createTask()}
          disabled={isChatEmpty}
          className="flex size-7 items-center justify-center rounded-md hover:bg-accent transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          title="New chat"
        >
          <Plus size={16} className="text-muted-foreground" />
        </button>
      </div>

      <TaskListContent />
    </div>
  );
}

function TasksPanelSkeleton() {
  return (
    <div className="flex flex-col h-full bg-background border-r border-border/50">
      <div className="h-11 px-4 flex items-center shrink-0 border-b border-border/50" />
      <div className="flex-1 flex items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    </div>
  );
}

export function TasksPanel({ className }: { className?: string }) {
  return (
    <div className={cn("h-full", className)}>
      <ErrorBoundary
        fallback={() => (
          <div className="flex flex-col h-full bg-background border-r border-border/50">
            <div className="h-11 px-4 flex items-center shrink-0 border-b border-border/50" />
            <div className="flex-1 flex items-center justify-center px-4 text-center">
              <p className="text-xs text-muted-foreground">
                Unable to load tasks
              </p>
            </div>
          </div>
        )}
      >
        <Suspense fallback={<TasksPanelSkeleton />}>
          <TasksPanelContent />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
