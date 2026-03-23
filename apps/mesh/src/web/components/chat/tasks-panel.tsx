/**
 * Tasks Panel — Sidebar + Compact List
 *
 * Status-grouped list with 3 sections: Needs input, In progress, Done.
 * Dense, scannable rows. Collapsible groups with counts.
 */

import { useChat } from "@/web/components/chat/index";
import { useChatStable } from "@/web/components/chat/context";
import { AgentAvatar } from "@/web/components/agent-icon";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { formatTimeAgo } from "@/web/lib/format-time";
import {
  buildDisplayGroups,
  getTaskVerb,
  isActionable,
  STATUS_CONFIG,
  type DisplayGroup,
} from "@/web/lib/task-status";
import type { Task } from "./task/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useConnections,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  CheckDone02,
  ChevronRight,
  FilterLines,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.js";
import { Button } from "@deco/ui/components/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
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
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { useChatStore } from "./store/selectors";

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

function OwnerFilter() {
  const { ownerFilter, setOwnerFilter, isFilterChangePending } =
    useChatStable();

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
          className="size-7"
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

function AgentAvatarStack({
  agentIds,
  connectionMap,
  defaultAgent,
}: {
  agentIds: string[];
  connectionMap: Map<string, ConnectionEntity>;
  defaultAgent: { icon: string | null | undefined; title: string };
}) {
  const display =
    agentIds.length > 0
      ? agentIds.slice(0, 2).map((id) => {
          const conn = connectionMap.get(id);
          return conn ? { icon: conn.icon, title: conn.title } : defaultAgent;
        })
      : [defaultAgent];

  const extra = Math.max(0, agentIds.length - 2);

  return (
    <div className="flex -space-x-1 shrink-0">
      {display.map((agent, i) => (
        <div key={i} className="ring-1 ring-background rounded-full">
          <AgentAvatar icon={agent.icon} name={agent.title} size="xs" />
        </div>
      ))}
      {extra > 0 && (
        <div className="flex items-center justify-center size-5 rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-1 ring-background">
          +{extra}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────
// Group header
// ────────────────────────────────────────

function GroupHeader({
  group,
  isOpen,
  onToggle,
}: {
  group: DisplayGroup;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const Icon = group.icon;

  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-2 px-4 py-2 w-full hover:bg-accent/30 transition-colors cursor-pointer"
    >
      <ChevronRight
        size={12}
        className={cn(
          "text-muted-foreground transition-transform duration-150",
          isOpen && "rotate-90",
        )}
      />
      <Icon size={14} className={group.iconClassName} />
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {group.label}
      </span>
      <span className="text-xs text-muted-foreground/60 tabular-nums">
        {group.tasks.length}
      </span>
    </button>
  );
}

// ────────────────────────────────────────
// Task row
// ────────────────────────────────────────

function TaskRow({
  task,
  isActive,
  connectionMap,
  defaultAgent,
  onClick,
}: {
  task: Task;
  isActive: boolean;
  connectionMap: Map<string, ConnectionEntity>;
  defaultAgent: { icon: string | null | undefined; title: string };
  onClick: () => void;
}) {
  const { setTaskStatus, hideTask } = useChatStable();
  const status = task.status;
  const cachedMessages = useChatStore((s) => s.threadMessages[task.id]);
  const { verb, labelColor } = getTaskVerb(task, cachedMessages);

  const agentIds = task.agent_ids ?? [];
  const firstAgentId = agentIds[0];
  const primaryAgent =
    firstAgentId !== undefined
      ? (() => {
          const conn = connectionMap.get(firstAgentId);
          return conn ? { icon: conn.icon, title: conn.title } : defaultAgent;
        })()
      : defaultAgent;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors",
            isActive ? "bg-accent" : "hover:bg-accent/50",
          )}
          onClick={onClick}
        >
          {/* Agent avatar stack */}
          <div className="shrink-0">
            <AgentAvatarStack
              agentIds={agentIds}
              connectionMap={connectionMap}
              defaultAgent={defaultAgent}
            />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Line 1: Title + time */}
            <div className="flex items-center gap-1.5">
              <TruncatedText
                text={task.title || "Untitled"}
                className="text-sm text-foreground flex-1 min-w-0"
              />
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                {task.updated_at
                  ? formatTimeAgo(new Date(task.updated_at))
                  : ""}
              </span>
            </div>
            {/* Line 2: agent name · status verb */}
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="truncate">{primaryAgent.title}</span>
              <span>·</span>
              <span className={cn("shrink-0", labelColor)}>{verb}</span>
            </div>
          </div>
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
// Filter popover
// ────────────────────────────────────────

const STATUS_FILTER_OPTIONS = Object.entries(STATUS_CONFIG).map(
  ([key, cfg]) => ({ key, label: cfg.label }),
);

function FilterPopover({
  statusFilter,
  agentFilter,
  availableAgents,
  connectionMap,
  defaultAgent,
  onStatusChange,
  onAgentChange,
}: {
  statusFilter: Set<string>;
  agentFilter: Set<string>;
  availableAgents: string[];
  connectionMap: Map<string, ConnectionEntity>;
  defaultAgent: { icon: string | null | undefined; title: string };
  onStatusChange: (status: string) => void;
  onAgentChange: (agentId: string) => void;
}) {
  const hasFilters = statusFilter.size > 0 || agentFilter.size > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="size-7 relative"
          title="Filter tasks"
        >
          <FilterLines size={14} className="text-muted-foreground" />
          {hasFilters && (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-blue-500" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-3">
        <div className="flex flex-col gap-3">
          {/* Status */}
          <div>
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Status
            </p>
            <div className="flex flex-col gap-1">
              {STATUS_FILTER_OPTIONS.map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={statusFilter.has(key)}
                    onChange={() => onStatusChange(key)}
                    className="rounded border-border accent-foreground"
                  />
                  <span className="text-xs text-foreground">{label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Agent — only shown if there are multiple agents in current tasks */}
          {availableAgents.length > 1 && (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                Agent
              </p>
              <div className="flex flex-col gap-1">
                {availableAgents.map((agentId) => {
                  const conn = connectionMap.get(agentId);
                  const agent = conn
                    ? { icon: conn.icon, title: conn.title }
                    : defaultAgent;
                  return (
                    <label
                      key={agentId}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={agentFilter.has(agentId)}
                        onChange={() => onAgentChange(agentId)}
                        className="rounded border-border accent-foreground"
                      />
                      <AgentAvatar
                        icon={agent.icon}
                        name={agent.title}
                        size="xs"
                      />
                      <span className="text-xs text-foreground truncate">
                        {agent.title}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ────────────────────────────────────────
// Core list (sidebar + side-panel)
// ────────────────────────────────────────

interface TaskListContentProps {
  onTaskSelect?: (taskId: string) => void;
}

export function TaskListContent({ onTaskSelect }: TaskListContentProps) {
  const { activeTaskId, switchToTask } = useChat();
  const { tasks } = useChatStable();
  const { org } = useProjectContext();

  const connections = useConnections();
  const connectionMap = new Map<string, ConnectionEntity>(
    (connections ?? []).map((c): [string, ConnectionEntity] => [c.id, c]),
  );

  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [agentFilter, setAgentFilter] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const visible = tasks.filter((t) => !t.hidden);

  const searched = searchQuery.trim()
    ? visible.filter((t) =>
        t.title.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : visible;

  // Apply status + agent filters
  const filtered = searched.filter((task) => {
    if (
      statusFilter.size > 0 &&
      !statusFilter.has(task.status ?? "completed")
    ) {
      return false;
    }
    if (
      agentFilter.size > 0 &&
      !task.agent_ids?.some((id) => agentFilter.has(id))
    ) {
      return false;
    }
    return true;
  });

  const groups = buildDisplayGroups(filtered);

  // Collect unique agent IDs across all visible tasks for the filter
  const availableAgents = [
    ...new Set(visible.flatMap((t) => t.agent_ids ?? [])),
  ];

  const toggleStatus = (key: string) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAgent = (id: string) => {
    setAgentFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSelect = async (task: Task) => {
    if (onTaskSelect) {
      onTaskSelect(task.id);
    } else {
      await switchToTask(task.id);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search + filter row */}
      <div className="flex items-center gap-1 px-1">
        <div className="flex-1">
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
        </div>
        <FilterPopover
          statusFilter={statusFilter}
          agentFilter={agentFilter}
          availableAgents={availableAgents}
          connectionMap={connectionMap}
          defaultAgent={defaultAgent}
          onStatusChange={toggleStatus}
          onAgentChange={toggleAgent}
        />
      </div>

      {/* Grouped list */}
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <EmptyState
            image={
              <CheckDone02 size={40} className="text-muted-foreground/40" />
            }
            title={
              searchQuery || statusFilter.size > 0 || agentFilter.size > 0
                ? "No matches"
                : "No tasks yet"
            }
            description={
              searchQuery || statusFilter.size > 0 || agentFilter.size > 0
                ? "No tasks match the current filters"
                : "Tasks appear here as agents work."
            }
            className="py-12"
          />
        ) : (
          <div className="flex flex-col">
            {groups.map((group) => {
              const isGroupOpen = !collapsed[group.key];
              return (
                <div key={group.key}>
                  <GroupHeader
                    group={group}
                    isOpen={isGroupOpen}
                    onToggle={() => toggleGroup(group.key)}
                  />
                  {isGroupOpen &&
                    group.tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        isActive={task.id === activeTaskId}
                        connectionMap={connectionMap}
                        defaultAgent={defaultAgent}
                        onClick={() => handleSelect(task)}
                      />
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────
// Home page sidebar wrapper
// ────────────────────────────────────────

function TasksPanelContent({
  onTaskSelect,
}: {
  onTaskSelect?: (taskId: string) => void;
}) {
  const { createTask, isChatEmpty } = useChat();
  const { tasks } = useChatStable();

  const reviewCount = tasks.filter(
    (t) => !t.hidden && isActionable(t.status),
  ).length;

  return (
    <div className="flex flex-col h-full bg-background border-r border-border/50">
      {/* Header */}
      <div className="h-11 px-4 flex items-center justify-between shrink-0 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">Tasks</span>
          {reviewCount > 0 && (
            <span className="flex items-center justify-center size-5 rounded-full bg-orange-500 text-white text-[10px] font-semibold tabular-nums">
              {reviewCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <OwnerFilter />
          <button
            type="button"
            onClick={() => createTask()}
            disabled={isChatEmpty}
            className="flex size-7 items-center justify-center rounded-md hover:bg-accent transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="New task"
          >
            <Plus size={16} className="text-muted-foreground" />
          </button>
        </div>
      </div>

      <TaskListContent onTaskSelect={onTaskSelect} />
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

export function TasksPanel({
  className,
  onTaskSelect,
}: {
  className?: string;
  onTaskSelect?: (taskId: string) => void;
}) {
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
          <TasksPanelContent onTaskSelect={onTaskSelect} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
