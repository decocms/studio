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
  type StatusKey,
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
  Archive,
} from "@untitledui/icons";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { useRef, useState } from "react";
import { User as UserIcon, Users as UsersIcon } from "lucide-react";
import { Button } from "@deco/ui/components/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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

export function OwnerFilter() {
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
  connectionMap: Map<
    string,
    { icon: string | null | undefined; title: string }
  >;
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

  const total = display.length + (extra > 0 ? 1 : 0);

  return (
    <div className="flex shrink-0">
      {display.map((agent, i) => (
        <div
          key={i}
          style={{ zIndex: total - i }}
          className={cn(
            "ring-1 ring-background rounded-md transition-all duration-150 ease-out",
            i > 0 && "-ml-[20px] group-hover/row:-ml-1",
          )}
        >
          <AgentAvatar icon={agent.icon} name={agent.title} size="xs" />
        </div>
      ))}
      {extra > 0 && (
        <div
          style={{ zIndex: 0 }}
          className={cn(
            "flex items-center justify-center size-6 rounded-md bg-muted text-[9px] font-medium text-muted-foreground ring-1 ring-background transition-all duration-150 ease-out",
            "-ml-[20px] group-hover/row:-ml-1",
          )}
        >
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
      className="group flex items-center gap-1.5 px-4 py-3 w-full hover:bg-accent/30 transition-colors cursor-pointer"
    >
      <Icon size={14} className={group.iconClassName} />
      <span className="text-sm font-medium text-muted-foreground">
        {group.label}
      </span>
      {!isOpen && (
        <span className="text-xs text-muted-foreground/60 tabular-nums">
          {group.tasks.length}
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
  connectionMap,
  defaultAgent,
  onClick,
}: {
  task: Task;
  isActive: boolean;
  connectionMap: Map<
    string,
    { icon: string | null | undefined; title: string }
  >;
  defaultAgent: { icon: string | null | undefined; title: string };
  onClick: () => void;
}) {
  const { setTaskStatus, hideTask } = useChatStable();
  const status = task.status;
  const cachedMessages = useChatStore((s) => s.threadMessages[task.id]);
  const taskVerb = getTaskVerb(task, cachedMessages);

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
            "group/row relative flex items-center gap-3 px-4 py-3.5 cursor-pointer transition-colors",
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
              <span className="text-xs text-muted-foreground tabular-nums shrink-0 whitespace-nowrap opacity-100 group-hover/row:opacity-0 transition-opacity">
                {task.updated_at
                  ? formatTimeAgo(new Date(task.updated_at))
                  : ""}
              </span>
            </div>
            {/* Line 2: agent name · status verb (only when actionable) */}
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="truncate">{primaryAgent.title}</span>
              {taskVerb && (
                <>
                  <span>·</span>
                  <span className={cn("shrink-0", taskVerb.labelColor)}>
                    {taskVerb.verb}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Archive button — shown on hover */}
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 size-6 flex items-center justify-center rounded-md hover:bg-accent transition-opacity opacity-0 group-hover/row:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              hideTask(task.id);
            }}
            title="Archive"
          >
            <Archive size={14} className="text-muted-foreground" />
          </button>
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
// Filter dropdown
// ────────────────────────────────────────

function FilterDropdown({
  statusFilter,
  agentFilter,
  availableAgents,
  connectionMap,
  defaultAgent,
  onStatusChange,
  onAgentChange,
}: {
  statusFilter: Set<StatusKey>;
  agentFilter: Set<string>;
  availableAgents: string[];
  connectionMap: Map<
    string,
    { icon: string | null | undefined; title: string }
  >;
  defaultAgent: { icon: string | null | undefined; title: string };
  onStatusChange: (status: StatusKey) => void;
  onAgentChange: (agentId: string) => void;
}) {
  const hasFilters = statusFilter.size > 0 || agentFilter.size > 0;
  const showAgents = availableAgents.length > 1;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex size-7 items-center justify-center rounded-md hover:bg-accent transition-colors shrink-0"
          title="Filter"
        >
          <FilterLines
            size={14}
            className={cn(
              hasFilters ? "text-foreground" : "text-muted-foreground/50",
            )}
          />
          {hasFilters && (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-blue-500" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Status
        </DropdownMenuLabel>
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
          const Icon = cfg.icon;
          return (
            <DropdownMenuCheckboxItem
              key={key}
              checked={statusFilter.has(key as StatusKey)}
              onCheckedChange={() => onStatusChange(key as StatusKey)}
            >
              <Icon size={12} className={cfg.iconClassName} />
              {cfg.label}
            </DropdownMenuCheckboxItem>
          );
        })}
        {showAgents && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Agent
            </DropdownMenuLabel>
            {availableAgents.map((agentId) => {
              const conn = connectionMap.get(agentId);
              const agent = conn ?? defaultAgent;
              return (
                <DropdownMenuCheckboxItem
                  key={agentId}
                  checked={agentFilter.has(agentId)}
                  onCheckedChange={() => onAgentChange(agentId)}
                >
                  <AgentAvatar icon={agent.icon} name={agent.title} size="xs" />
                  <span className="truncate">{agent.title}</span>
                </DropdownMenuCheckboxItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const { tasks, virtualMcps } = useChatStable();
  const { org } = useProjectContext();

  const connections = useConnections();
  // Build a unified agent lookup: connections + virtual MCPs
  const connectionMap = new Map<
    string,
    { icon: string | null | undefined; title: string }
  >();
  for (const c of connections ?? []) {
    connectionMap.set(c.id, { icon: c.icon, title: c.title });
  }
  for (const v of virtualMcps) {
    if (v.id) connectionMap.set(v.id, { icon: v.icon, title: v.title });
  }

  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<StatusKey>>(new Set());
  const [agentFilter, setAgentFilter] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const visible = tasks.filter((t) => !t.hidden);

  const availableAgents = [
    ...new Set(visible.flatMap((t) => t.agent_ids ?? [])),
  ];

  const searched = searchQuery.trim()
    ? visible.filter((t) =>
        t.title.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : visible;

  const filtered = searched.filter((task) => {
    if (
      statusFilter.size > 0 &&
      !statusFilter.has((task.status ?? "completed") as StatusKey)
    )
      return false;
    if (agentFilter.size > 0) {
      const taskAgents = task.agent_ids ?? [];
      if (!taskAgents.some((id) => agentFilter.has(id))) return false;
    }
    return true;
  });

  const groups = buildDisplayGroups(filtered);

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
      {/* Search + Filter */}
      <div className="px-2 pt-1 pb-1 flex items-center gap-1">
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
        <FilterDropdown
          statusFilter={statusFilter}
          agentFilter={agentFilter}
          availableAgents={availableAgents}
          connectionMap={connectionMap}
          defaultAgent={defaultAgent}
          onStatusChange={(s) =>
            setStatusFilter((prev) => {
              const next = new Set(prev);
              if (next.has(s)) next.delete(s);
              else next.add(s);
              return next;
            })
          }
          onAgentChange={(a) =>
            setAgentFilter((prev) => {
              const next = new Set(prev);
              if (next.has(a)) next.delete(a);
              else next.add(a);
              return next;
            })
          }
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
          <div className="flex flex-col gap-1">
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
