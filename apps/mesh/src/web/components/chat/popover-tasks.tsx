import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Check, Clock, Edit01, SearchMd, Trash01 } from "@untitledui/icons";
import { useRef, useState } from "react";
import { useChatStable } from "./context";
import type { Task } from "./task/types.ts";

type TaskSection = {
  label: string;
  tasks: Task[];
  showRelativeTime: boolean;
};

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  return `${diffHours}h`;
}

function groupTasksByDate(tasks: Task[]): TaskSection[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const last7Days = new Date(today.getTime() - 7 * 86400000);
  const last30Days = new Date(today.getTime() - 30 * 86400000);

  const todayTasks: Task[] = [];
  const yesterdayTasks: Task[] = [];
  const last7DaysTasks: Task[] = [];
  const last30DaysTasks: Task[] = [];
  const olderTasks: Task[] = [];

  for (const task of tasks) {
    const date = new Date(task.updated_at);
    if (date >= today) {
      todayTasks.push(task);
    } else if (date >= yesterday) {
      yesterdayTasks.push(task);
    } else if (date >= last7Days) {
      last7DaysTasks.push(task);
    } else if (date >= last30Days) {
      last30DaysTasks.push(task);
    } else {
      olderTasks.push(task);
    }
  }

  const result: TaskSection[] = [];
  if (todayTasks.length > 0) {
    result.push({
      label: "Today",
      tasks: todayTasks,
      showRelativeTime: true,
    });
  }
  if (yesterdayTasks.length > 0) {
    result.push({
      label: "Yesterday",
      tasks: yesterdayTasks,
      showRelativeTime: false,
    });
  }
  if (last7DaysTasks.length > 0) {
    result.push({
      label: "7 days ago",
      tasks: last7DaysTasks,
      showRelativeTime: false,
    });
  }
  if (last30DaysTasks.length > 0) {
    result.push({
      label: "30 days ago",
      tasks: last30DaysTasks,
      showRelativeTime: false,
    });
  }
  if (olderTasks.length > 0) {
    result.push({
      label: "Older",
      tasks: olderTasks,
      showRelativeTime: false,
    });
  }

  return result;
}

export function TaskHistoryPopover({
  variant = "icon",
}: {
  variant?: "outline" | "icon";
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const {
    activeTaskId,
    switchToTask,
    tasks,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    hideTask,
    renameTask,
  } = useChatStable();
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Set up intersection observer for infinite scroll
  const observerRef = useRef<IntersectionObserver | null>(null);
  const setupObserver = (node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    if (node && hasNextPage && !isFetchingNextPage && fetchNextPage) {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          if (
            entries[0]?.isIntersecting &&
            hasNextPage &&
            !isFetchingNextPage &&
            fetchNextPage
          ) {
            fetchNextPage();
          }
        },
        { rootMargin: "100px" },
      );
      observerRef.current.observe(node);
    }

    sentinelRef.current = node;
  };

  const filteredTasks = searchQuery.trim()
    ? tasks.filter((task) =>
        task.title.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : tasks;

  const sections = groupTasksByDate(filteredTasks);

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

  const handleKeyDown = (
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
    <TooltipProvider>
      <Tooltip>
        <Popover>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              {variant === "outline" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-7 border border-input"
                  aria-label="Chat history"
                >
                  <Clock size={16} />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 p-1 hover:bg-transparent"
                  aria-label="Chat history"
                >
                  <Clock
                    size={16}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  />
                </Button>
              )}
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Chat history</TooltipContent>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="border-b">
              <label className="flex items-center gap-2.5 h-12 px-4 cursor-text">
                <SearchMd
                  size={16}
                  className="text-muted-foreground shrink-0"
                />
                <input
                  type="text"
                  placeholder="Search chats..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1 border-0 shadow-none focus:outline-none px-0 h-full text-sm placeholder:text-muted-foreground/50 bg-transparent"
                />
              </label>
            </div>

            <div className="max-h-[300px] overflow-y-auto">
              {filteredTasks.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  {searchQuery.trim() ? "No chats found" : "No chats yet"}
                </div>
              ) : (
                <>
                  {sections.map((section, sectionIndex) => (
                    <div key={section.label}>
                      {sectionIndex > 0 && <div className="border-t mx-3" />}
                      <div className="px-3 py-1">
                        <span className="text-xs font-medium text-muted-foreground tracking-wide">
                          {section.label}
                        </span>
                      </div>
                      {section.tasks.map((task) => {
                        const isActive = task.id === activeTaskId;
                        const isEditing = editingTaskId === task.id;
                        return (
                          <div
                            key={task.id}
                            className={cn(
                              "flex items-center gap-2 px-3 py-2 hover:bg-accent cursor-pointer group",
                              isActive && "bg-accent/50",
                            )}
                            onClick={() => !isEditing && switchToTask(task.id)}
                          >
                            <div className="flex-1 min-w-0">
                              {isEditing ? (
                                <div
                                  className="flex items-center gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    autoFocus
                                    value={editingTitle}
                                    onChange={(e) =>
                                      setEditingTitle(e.target.value)
                                    }
                                    onBlur={() => commitEdit(task.id)}
                                    onKeyDown={(e) => handleKeyDown(e, task.id)}
                                    className="flex-1 text-sm bg-transparent border-b border-foreground/30 focus:border-foreground outline-none pb-0.5 min-w-0"
                                  />
                                  <button
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => commitEdit(task.id)}
                                    className="p-0.5 hover:bg-accent rounded shrink-0"
                                  >
                                    <Check
                                      size={12}
                                      className="text-muted-foreground hover:text-foreground"
                                    />
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <span className="text-sm truncate">
                                    {task.title || "New chat"}
                                  </span>
                                  <span className="text-xs text-muted-foreground shrink-0">
                                    {isActive
                                      ? "current"
                                      : section.showRelativeTime
                                        ? formatRelativeTime(task.updated_at)
                                        : null}
                                  </span>
                                </div>
                              )}
                            </div>
                            {!isEditing && (
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  onClick={(e) => startEditing(task, e)}
                                  className="opacity-0 cursor-pointer group-hover:opacity-100 p-1 hover:bg-accent rounded transition-opacity"
                                  title="Rename chat"
                                >
                                  <Edit01
                                    size={13}
                                    className="text-muted-foreground hover:text-foreground"
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    hideTask(task.id);
                                  }}
                                  className="opacity-0 cursor-pointer group/trash group-hover:opacity-100 p-1 hover:bg-destructive/10 rounded transition-opacity"
                                  title="Remove chat"
                                >
                                  <Trash01
                                    size={14}
                                    className="text-muted-foreground group-hover/trash:text-destructive"
                                  />
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {/* Sentinel for infinite scroll */}
                  {!searchQuery.trim() && hasNextPage && (
                    <div ref={setupObserver} className="h-4" />
                  )}
                  {/* Loading indicator */}
                  {isFetchingNextPage && (
                    <div className="p-3 text-center text-xs text-muted-foreground">
                      Loading more chats...
                    </div>
                  )}
                </>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </Tooltip>
    </TooltipProvider>
  );
}
