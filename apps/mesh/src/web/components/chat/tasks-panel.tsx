/**
 * Tasks Panel — Sidebar + Compact List
 *
 * Status-grouped list with 3 sections: Needs input, In progress, Done.
 * Dense, scannable rows. Collapsible groups with counts.
 */

import { useChatTask } from "@/web/components/chat/context";
import { useVirtualMCPURLContext } from "@/web/contexts/virtual-mcp-context";
import { formatTimeAgo, formatTimeUntil } from "@/web/lib/format-time";
import {
  buildDisplayGroups,
  getTaskVerb,
  STATUS_CONFIG,
  toDisplayGroupKey,
} from "@/web/lib/task-status";
import type { Task } from "./task/types";
import { useTasks } from "./task";
import { authClient } from "../../lib/auth-client";
import { useSearch } from "@tanstack/react-router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  CheckDone01,
  ChevronRight,
  Loading01,
  Plus,
  RefreshCcw01,
} from "@untitledui/icons";
import { useRef, useState } from "react";
import { User as UserIcon, Users as UsersIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@deco/ui/components/context-menu.tsx";
import type { TaskOwnerFilter } from "./task";
import {
  useAutomationsList,
  useAutomationCreate,
  useAutomationDelete,
  buildDefaultAutomationInput,
  type AutomationListItem,
} from "@/web/hooks/use-automations";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Trash01 } from "@untitledui/icons";
import { usePlayStatusSound } from "@/web/hooks/use-status-sounds";

// ────────────────────────────────────────

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

export function OwnerFilter() {
  const { ownerFilter, setOwnerFilter, isFilterChangePending } = useChatTask();

  const isFiltered = ownerFilter === "me";
  const Icon = isFilterChangePending
    ? Loading01
    : isFiltered
      ? UserIcon
      : UsersIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md transition-colors text-muted-foreground hover:bg-accent hover:text-foreground"
          title={isFiltered ? "My tasks" : "All tasks"}
          disabled={isFilterChangePending}
        >
          <Icon
            size={16}
            className={cn(isFilterChangePending && "animate-spin")}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={ownerFilter}
          onValueChange={(v) => setOwnerFilter(v as TaskOwnerFilter)}
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

// ────────────────────────────────────────
// Multi-agent avatar stack
// ────────────────────────────────────────

// ────────────────────────────────────────
// Section empty state
// ────────────────────────────────────────

function SectionEmptyState() {
  return (
    <div className="mx-2 px-2 py-3 text-xs text-muted-foreground/60">
      No items
    </div>
  );
}

// ────────────────────────────────────────
// Group header
// ────────────────────────────────────────

function GroupHeader({
  label,
  icon: Icon,
  iconClassName,
  count,
  isOpen,
  onToggle,
}: {
  label: string;
  icon: typeof Loading01;
  iconClassName: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group flex items-center gap-1.5 mx-2 px-3 h-10 rounded-md w-[calc(100%-1rem)] text-sm hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
    >
      <Icon size={16} className={iconClassName} />
      <span className="text-sm font-medium text-foreground">{label}</span>
      {!isOpen && (
        <span className="text-xs text-muted-foreground/60 tabular-nums">
          {count}
        </span>
      )}
      <ChevronRight
        size={12}
        className={cn(
          "text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-all duration-150",
          isOpen && "rotate-90",
        )}
      />
    </button>
  );
}

// ────────────────────────────────────────
// Task row
// ────────────────────────────────────────

function TaskRow({
  task,
  isActive,
  onClick,
}: {
  task: Task;
  isActive: boolean;
  onClick: () => void;
}) {
  const { setTaskStatus, hideTask } = useChatTask();
  const playStatusSound = usePlayStatusSound();
  const status = task.status;
  const taskVerb = getTaskVerb(task, undefined);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group/row relative flex items-center gap-3 mx-2 px-3 h-10 rounded-md w-[calc(100%-1rem)] cursor-pointer transition-colors",
            isActive ? "bg-accent" : "hover:bg-accent/50",
          )}
          onClick={onClick}
        >
          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Line 1: Title + time */}
            <div className="flex items-center gap-1.5">
              <TruncatedText
                text={task.title || "Untitled"}
                className="text-sm text-muted-foreground flex-1 min-w-0"
              />
              <span className="text-xs text-muted-foreground tabular-nums shrink-0 whitespace-nowrap opacity-100 group-hover/row:opacity-0 transition-opacity">
                {task.updated_at
                  ? formatTimeAgo(new Date(task.updated_at))
                  : ""}
              </span>
            </div>
            {/* Line 2: status verb (only when actionable) */}
            {taskVerb && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className={cn("shrink-0", taskVerb.labelColor)}>
                  {taskVerb.verb}
                </span>
              </div>
            )}
          </div>

          {/* Mark done button — shown on hover for non-completed tasks */}
          {status !== "completed" && (
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 size-6 flex items-center justify-center rounded-md hover:bg-accent transition-opacity opacity-0 group-hover/row:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                playStatusSound("completed");
                void setTaskStatus(task.id, "completed");
              }}
              title="Mark as done"
            >
              <CheckDone01 size={14} className="text-muted-foreground" />
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuSub>
          <ContextMenuSubTrigger>Set status</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
              const Icon = cfg.icon;
              return (
                <ContextMenuItem
                  key={key}
                  className={cn("gap-2", status === key && "font-medium")}
                  onSelect={() => void setTaskStatus(task.id, key)}
                >
                  <Icon size={14} className={cfg.iconClassName} />
                  <span>{cfg.label}</span>
                  {status === key && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      current
                    </span>
                  )}
                </ContextMenuItem>
              );
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onSelect={() => hideTask(task.id)}
        >
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ────────────────────────────────────────
// Automation row
// ────────────────────────────────────────

function AutomationRow({
  automation,
  onClick,
  onDelete,
}: {
  automation: AutomationListItem;
  onClick: () => void;
  onDelete: () => void;
}) {
  const nextRun = automation.nearest_next_run_at;

  return (
    <div
      className="group/row relative flex items-center gap-3 mx-2 px-3 h-10 rounded-md w-[calc(100%-1rem)] cursor-pointer transition-colors hover:bg-accent/50"
      onClick={onClick}
    >
      <span
        className={cn(
          "text-sm truncate flex-1 min-w-0",
          automation.active && automation.trigger_count > 0
            ? "text-foreground"
            : "text-muted-foreground",
        )}
      >
        {automation.name || "Untitled"}
      </span>
      {/* Status / delete button — overlaid in same cell to avoid layout shift */}
      <div className="shrink-0 grid [grid-template-areas:'slot'] items-center justify-items-end">
        <span className="[grid-area:slot] text-xs text-muted-foreground tabular-nums whitespace-nowrap group-hover/row:invisible">
          {nextRun ? formatTimeUntil(new Date(nextRun)) : "No starters"}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="[grid-area:slot] invisible group-hover/row:visible flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash01 size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Delete automation</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ────────────────────────────────────────
// Incoming section (automations)
// ────────────────────────────────────────

function IncomingSection({ virtualMcpId }: { virtualMcpId: string }) {
  const virtualMcpCtx = useVirtualMCPURLContext();
  const { data: allAutomations } = useAutomationsList(virtualMcpId);
  const createMutation = useAutomationCreate();
  const deleteMutation = useAutomationDelete();
  const [isOpen, setIsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const automations = (allAutomations ?? [])
    .slice()
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

  const navigateToAutomation = (automationId?: string) => {
    if (automationId) {
      virtualMcpCtx?.openMainView("automation", { id: automationId });
    } else {
      virtualMcpCtx?.openMainView("default");
    }
  };

  const handleCreate = async () => {
    try {
      const result = await createMutation.mutateAsync(
        buildDefaultAutomationInput(virtualMcpId),
      );
      navigateToAutomation(result.id);
    } catch {
      // silently fail — the mutation hook handles cache invalidation
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      // If we're currently viewing the deleted automation, navigate away
      const currentView = virtualMcpCtx?.mainView;
      if (
        currentView?.type === "automation" &&
        currentView.id === deleteTarget.id
      ) {
        virtualMcpCtx?.openMainView("default");
      }
    } catch {
      // silently fail
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="group/incoming flex items-center gap-1.5 mx-2 px-3 h-10 rounded-md w-[calc(100%-1rem)] text-sm hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
      >
        <RefreshCcw01 size={14} className="text-purple-500" />
        <span className="text-sm font-medium text-muted-foreground">
          Automations
        </span>
        {!isOpen && (
          <span className="text-xs text-muted-foreground/60 tabular-nums">
            {automations.filter((a) => a.active && a.trigger_count > 0).length}/
            {automations.length}
          </span>
        )}
        <ChevronRight
          size={12}
          className={cn(
            "text-muted-foreground/40 opacity-0 group-hover/incoming:opacity-100 transition-all duration-150",
            isOpen && "rotate-90",
          )}
        />
        <span className="flex-1" />
        <span
          role="button"
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md transition-all text-muted-foreground hover:bg-accent hover:text-foreground",
            createMutation.isPending
              ? "opacity-100"
              : "opacity-0 group-hover/incoming:opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            handleCreate();
          }}
          title="Create automation"
        >
          {createMutation.isPending ? (
            <Loading01 size={16} className="animate-spin" />
          ) : (
            <Plus size={16} />
          )}
        </span>
      </button>
      {isOpen &&
        (automations.length > 0 ? (
          automations.map((automation) => (
            <AutomationRow
              key={automation.id}
              automation={automation}
              onClick={() => navigateToAutomation(automation.id)}
              onDelete={() =>
                setDeleteTarget({ id: automation.id, name: automation.name })
              }
            />
          ))
        ) : (
          <SectionEmptyState />
        ))}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Automation?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.name || "Untitled"}
              </span>
              . All triggers will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ────────────────────────────────────────
// Core list (sidebar + side-panel)
// ────────────────────────────────────────

// ────────────────────────────────────────
// Grouped task list — keyed by activeGroupKey so expanded state resets
// when the active task moves between groups
// ────────────────────────────────────────

function GroupedTaskList({
  groups,
  activeGroupKey,
  activeTaskId,
  virtualMcpId,
  showAutomations = true,
  onTaskSelect,
}: {
  groups: ReturnType<typeof buildDisplayGroups>;
  activeGroupKey: string | null;
  activeTaskId: string | null;
  virtualMcpId?: string | null;
  showAutomations?: boolean;
  onTaskSelect: (task: Task) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    // Default: auto-open the group containing the active task
    if (activeGroupKey) return { [activeGroupKey]: true };
    return {};
  });

  const toggleGroup = (key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="flex-1 overflow-y-auto">
      {groups
        .filter((g) => g.key !== "done")
        .map((group, index) => {
          const isOpen = !!expanded[group.key];
          return (
            <div key={group.key} className={cn(index > 0 && "mt-3")}>
              <GroupHeader
                label={group.label}
                icon={group.icon}
                iconClassName={group.iconClassName}
                count={group.tasks.length}
                isOpen={isOpen}
                onToggle={() => toggleGroup(group.key)}
              />
              {isOpen && (
                <div className="mt-1">
                  {group.tasks.length > 0 ? (
                    group.tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        isActive={task.id === activeTaskId}
                        onClick={() => onTaskSelect(task)}
                      />
                    ))
                  ) : (
                    <SectionEmptyState />
                  )}
                </div>
              )}
            </div>
          );
        })}
      {virtualMcpId && showAutomations && (
        <div className="mt-3">
          <IncomingSection virtualMcpId={virtualMcpId} />
        </div>
      )}
      {groups
        .filter((g) => g.key === "done")
        .map((group) => {
          const isOpen = !!expanded[group.key];
          return (
            <div key={group.key} className="mt-3">
              <GroupHeader
                label={group.label}
                icon={group.icon}
                iconClassName={group.iconClassName}
                count={group.tasks.length}
                isOpen={isOpen}
                onToggle={() => toggleGroup(group.key)}
              />
              {isOpen && (
                <div className="mt-1">
                  {group.tasks.length > 0 ? (
                    group.tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        isActive={task.id === activeTaskId}
                        onClick={() => onTaskSelect(task)}
                      />
                    ))
                  ) : (
                    <SectionEmptyState />
                  )}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

// ────────────────────────────────────────

interface TaskListContentProps {
  onTaskSelect?: (taskId: string) => void;
  virtualMcpId?: string | null;
  showAutomations?: boolean;
}

export function TaskListContent({
  onTaskSelect,
  virtualMcpId,
  showAutomations = true,
}: TaskListContentProps) {
  const { openTask, ownerFilter } = useChatTask();

  // Read taskId directly from router (seeded by validateSearch)
  const search = useSearch({ strict: false }) as { taskId?: string };
  const taskId = search.taskId ?? null;

  // Own task list fetch — shares TanStack Query cache with ChatContextProvider
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const { tasks } = useTasks(
    ownerFilter,
    ownerFilter === "me" ? userId : undefined,
    virtualMcpId ?? "",
  );

  const visible = tasks.filter((t) => !t.hidden);
  const groups = buildDisplayGroups(visible);

  // Find which group the active task belongs to so we can auto-open it
  const activeTask = taskId ? visible.find((t) => t.id === taskId) : null;
  const activeGroupKey = activeTask
    ? toDisplayGroupKey(activeTask.status)
    : null;

  const handleSelect = (task: Task) => {
    if (onTaskSelect) {
      onTaskSelect(task.id);
    } else {
      openTask(task.id);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tasks header */}
      <div className="px-2 py-1 flex items-center gap-0.5 min-h-12">
        <span className="flex-1 text-xs font-medium text-muted-foreground px-2">
          Tasks
        </span>
      </div>

      {/* Grouped list — key resets expanded state when active task moves groups */}
      <GroupedTaskList
        key={activeGroupKey ?? "none"}
        groups={groups}
        activeGroupKey={activeGroupKey}
        activeTaskId={taskId}
        virtualMcpId={virtualMcpId}
        showAutomations={showAutomations}
        onTaskSelect={handleSelect}
      />
    </div>
  );
}
