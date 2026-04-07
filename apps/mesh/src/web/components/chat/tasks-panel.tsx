/**
 * Tasks Panel — Sidebar + Compact List
 *
 * Flat list sorted by updated_at with inline status icons.
 * Dense, scannable rows. Automations section above tasks.
 */

import { useChatTask } from "@/web/components/chat/context";
import {
  useMainViewActions,
  useTaskActions,
} from "@/web/contexts/panel-context";
import { useVirtualMCPURLContext } from "@/web/contexts/virtual-mcp-context";
import { formatTimeAgo, formatTimeUntil } from "@/web/lib/format-time";
import {
  getStatusConfig,
  getTaskVerb,
  SETTABLE_STATUSES,
  STATUS_CONFIG,
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
import { Loading01, Plus, RefreshCcw01 } from "@untitledui/icons";
import { useRef, useState } from "react";
import { User as UserIcon, Users as UsersIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.js";
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
import { Archive, Trash01 } from "@untitledui/icons";
import { useSound } from "@/web/hooks/use-sound.ts";
import { question004Sound } from "@deco/ui/lib/question-004.ts";

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
  const playSound = useSound(question004Sound);
  const status = task.status;
  const config = getStatusConfig(status);
  const StatusIcon = config.icon;
  const taskVerb = getTaskVerb(task, undefined);
  const tooltipText = taskVerb?.verb ?? config.label;

  return (
    <div
      className={cn(
        "group/row relative flex items-center gap-2 mx-2 px-3 h-10 rounded-md w-[calc(100%-1rem)] cursor-pointer",
        isActive ? "bg-accent" : "hover:bg-accent/50",
      )}
      onClick={onClick}
    >
      {/* Status icon — click to change status */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="shrink-0 flex items-center justify-center size-6 rounded-md hover:bg-accent/80"
                onClick={(e) => e.stopPropagation()}
              >
                <StatusIcon
                  size={16}
                  className={cn(
                    config.iconClassName,
                    status === "in_progress" && "animate-spin",
                  )}
                />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{tooltipText}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent className="w-48">
          {SETTABLE_STATUSES.map((key) => {
            const cfg = STATUS_CONFIG[key];
            const Icon = cfg.icon;
            return (
              <DropdownMenuItem
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
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Title + time */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <TruncatedText
          text={task.title || "Untitled"}
          className="text-sm text-muted-foreground flex-1 min-w-0"
        />
        <span className="text-xs text-muted-foreground tabular-nums shrink-0 whitespace-nowrap group-hover/row:invisible">
          {task.updated_at ? formatTimeAgo(new Date(task.updated_at)) : ""}
        </span>
      </div>

      {/* Archive button — shown on hover */}
      <button
        type="button"
        className="absolute right-3 top-1/2 -translate-y-1/2 size-6 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground invisible group-hover/row:visible"
        onClick={(e) => {
          e.stopPropagation();
          playSound();
          hideTask(task.id);
        }}
        title="Archive"
      >
        <Archive size={14} />
      </button>
    </div>
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
      className="group/row relative flex items-center gap-2 mx-2 px-3 h-10 rounded-md w-[calc(100%-1rem)] cursor-pointer hover:bg-accent/50"
      onClick={onClick}
    >
      <RefreshCcw01 size={16} className="shrink-0 text-muted-foreground" />
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
  const { openMainView } = useMainViewActions();
  const { data: allAutomations } = useAutomationsList(virtualMcpId);
  const createMutation = useAutomationCreate();
  const deleteMutation = useAutomationDelete();
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
      openMainView("automation", { id: automationId });
    } else {
      openMainView("default");
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
      const currentView = virtualMcpCtx?.mainView;
      if (
        currentView?.type === "automation" &&
        currentView.id === deleteTarget.id
      ) {
        openMainView("default");
      }
    } catch {
      // silently fail
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center gap-2 mx-2 px-3 h-8 mt-2 w-[calc(100%-1rem)]">
        <span className="text-xs font-medium text-muted-foreground/60">
          Automations
        </span>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="button"
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md transition-all text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer",
              )}
              onClick={handleCreate}
            >
              {createMutation.isPending ? (
                <Loading01 size={16} className="animate-spin" />
              ) : (
                <Plus size={16} />
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent>New automation</TooltipContent>
        </Tooltip>
      </div>

      {/* Automation rows — always visible */}
      {automations.length > 0 ? (
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
        <div className="mx-2 px-2 py-3 text-xs text-muted-foreground/60">
          No automations
        </div>
      )}

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

interface TaskListContentProps {
  onTaskSelect?: (taskId: string) => void;
  onTaskCreate?: () => void;
  virtualMcpId?: string | null;
  showAutomations?: boolean;
}

export function TaskListContent({
  onTaskSelect,
  onTaskCreate,
  virtualMcpId,
  showAutomations = true,
}: TaskListContentProps) {
  const { ownerFilter } = useChatTask();
  const { setTaskId } = useTaskActions();

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

  const visible = tasks
    .filter((t) => !t.hidden)
    .slice()
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );

  const handleSelect = (task: Task) => {
    if (onTaskSelect) {
      onTaskSelect(task.id);
    } else {
      setTaskId(task.id);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto">
        {/* Automations section */}
        {virtualMcpId && showAutomations && (
          <IncomingSection virtualMcpId={virtualMcpId} />
        )}

        {/* Tasks section header */}
        <div className="flex items-center gap-2 mx-2 px-3 h-8 mt-2 w-[calc(100%-1rem)]">
          <span className="text-xs font-medium text-muted-foreground/60">
            Tasks
          </span>
          <span className="flex-1" />
          {onTaskCreate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="button"
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
                  onClick={onTaskCreate}
                >
                  <Plus size={16} />
                </span>
              </TooltipTrigger>
              <TooltipContent>New task</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Task rows — always visible */}
        {visible.length > 0 ? (
          visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              isActive={task.id === taskId}
              onClick={() => handleSelect(task)}
            />
          ))
        ) : (
          <div className="mx-2 px-2 py-3 text-xs text-muted-foreground/60">
            No tasks
          </div>
        )}
      </div>
    </div>
  );
}
