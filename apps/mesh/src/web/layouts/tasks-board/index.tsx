/**
 * Tasks board (/$org/tasks) — the org's tasks (threads) as a kanban or list.
 *
 * Columns are the real thread statuses (in progress, needs review, done,
 * failed) and dragging a card to another column persists the status via
 * ThreadManager. Data comes from the same `useThreads()` store the sidebar
 * uses, so rows stay live as runs progress. Filters narrow by agent and by
 * origin (manual vs automation-triggered).
 */

import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useProjectContext, useVirtualMCPs } from "@decocms/mesh-sdk";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Columns03,
  CpuChip01,
  List,
  Loading01,
  Plus,
  X,
  Zap,
} from "@untitledui/icons";
import { AgentAvatar } from "@/web/components/agent-icon";
import { useThreads } from "@/web/components/chat/store/hooks";
import type { Task } from "@/web/components/chat/task/types";
import { useThreadActions } from "@/web/components/chat/store/hooks";
import { formatTimeAgo } from "@/web/lib/format-time";
import { getStatusConfig } from "@/web/lib/task-status";
import { isSyntheticBranch } from "@/shared/is-synthetic-branch";
import { NewTaskDialog } from "./new-task-dialog";

type Lane = "in_progress" | "requires_action" | "completed" | "failed";

const LANES: Lane[] = ["in_progress", "requires_action", "completed", "failed"];

/** Buckets a thread's display status into one of the four columns.
 *  `expired` is a virtual read-time status for stale runs — it lives in the
 *  failed column but is never written back. */
function laneFor(status: Task["status"]): Lane {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "requires_action":
      return "requires_action";
    case "failed":
    case "expired":
      return "failed";
    case "completed":
    case undefined:
      return "completed";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

type Layout = "kanban" | "list";

/** Route component — the same rounded content card every routed page sits in
 *  (see Library): sidebar-colored gutter, then the card with the board. */
export default function TasksBoard() {
  return (
    <div className="min-h-0 flex-1 pt-0 pr-1 pb-1 pl-0">
      <div className="h-full p-0.5 pt-0.25">
        <div className="card-shadow flex h-full flex-col overflow-hidden rounded-[0.75rem] bg-background">
          <TasksBoardPage />
        </div>
      </div>
    </div>
  );
}

function TasksBoardPage() {
  const navigate = useNavigate();
  const { org } = useParams({ strict: false }) as { org?: string };
  const { org: organization } = useProjectContext();
  const { threads, status, hasMore, isFetchingMore, fetchNextPage } =
    useThreads();
  const actions = useThreadActions();
  const agents = useVirtualMCPs();

  const [layout, setLayout] = useState<Layout>("kanban");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [agentSel, setAgentSel] = useState<Set<string>>(new Set());
  const [originSel, setOriginSel] = useState<Set<string>>(new Set());

  const visibleThreads = threads.filter((t) => !t.hidden);

  // Agent options come from the agents actually present on the board, so the
  // menu never lists agents with nothing to filter.
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const agentOptions = [
    ...new Set(
      visibleThreads.flatMap((t) =>
        t.virtual_mcp_id ? [t.virtual_mcp_id] : [],
      ),
    ),
  ].map((id) => ({ key: id, label: agentById.get(id)?.title ?? "Decopilot" }));

  const matchesFilters = (t: Task) =>
    (agentSel.size === 0 ||
      (!!t.virtual_mcp_id && agentSel.has(t.virtual_mcp_id))) &&
    (originSel.size === 0 ||
      originSel.has(t.trigger_id ? "automation" : "manual"));

  const items = visibleThreads
    .filter(matchesFilters)
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );

  const anyFilter = agentSel.size + originSel.size > 0;
  const toggleIn =
    (set: Set<string>, update: (next: Set<string>) => void) =>
    (key: string) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      update(next);
    };

  const open = (taskId: string, virtualMcpId?: string) => {
    if (!org) return;
    navigate({
      to: "/$org/$taskId",
      params: { org, taskId },
      search: virtualMcpId ? { virtualmcpid: virtualMcpId } : {},
    });
  };

  if (status.kind === "loading" && threads.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-6 px-10 pt-10 pb-16",
          layout === "kanban" ? "max-w-[1400px]" : "max-w-[900px]",
        )}
      >
        <h1 className="text-xl font-medium text-foreground">Tasks</h1>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setNewTaskOpen(true)}>
            <Plus size={16} />
            New task
          </Button>

          <FilterMenu
            label="Agent"
            icon={CpuChip01}
            options={agentOptions}
            selected={agentSel}
            onToggle={toggleIn(agentSel, setAgentSel)}
          />
          <FilterMenu
            label="Origin"
            icon={Zap}
            options={[
              { key: "manual", label: "Started by a person" },
              { key: "automation", label: "Automation-triggered" },
            ]}
            selected={originSel}
            onToggle={toggleIn(originSel, setOriginSel)}
          />
          {anyFilter && (
            <button
              type="button"
              onClick={() => {
                setAgentSel(new Set());
                setOriginSel(new Set());
              }}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <X size={12} />
              Clear
            </button>
          )}

          <div className="ml-auto inline-flex rounded-lg bg-muted p-0.5">
            <LayoutToggle
              active={layout === "list"}
              onClick={() => setLayout("list")}
              icon={List}
              label="List"
            />
            <LayoutToggle
              active={layout === "kanban"}
              onClick={() => setLayout("kanban")}
              icon={Columns03}
              label="Board"
            />
          </div>
        </div>

        {items.length === 0 ? (
          <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
            No tasks yet. Start one with New task.
          </div>
        ) : layout === "kanban" ? (
          <KanbanBoard
            items={items}
            agentById={agentById}
            onOpen={open}
            onMove={(id, lane) => void actions.setStatus(id, lane)}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((t) => (
              <ListRow
                key={t.id}
                task={t}
                agent={
                  t.virtual_mcp_id ? agentById.get(t.virtual_mcp_id) : undefined
                }
                onOpen={() => open(t.id, t.virtual_mcp_id)}
              />
            ))}
          </div>
        )}

        {hasMore && (
          <Button
            variant="outline"
            size="sm"
            className="self-center"
            disabled={isFetchingMore}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingMore ? (
              <Loading01 size={14} className="animate-spin" />
            ) : null}
            Load more
          </Button>
        )}
      </div>

      <NewTaskDialog
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        orgName={organization.name}
        orgLogo={organization.logo ?? null}
      />
    </div>
  );
}

/** A Linear-style multi-select filter chip: a dropdown of checkbox options.
 *  Selecting keeps the menu open; the chip shows the active count. */
function FilterMenu({
  label,
  icon: Icon,
  options,
  selected,
  onToggle,
}: {
  label: string;
  icon: typeof Zap;
  options: { key: string; label: string }[];
  selected: Set<string>;
  onToggle: (key: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent/50",
            selected.size > 0
              ? "border-solid text-foreground"
              : "text-muted-foreground",
          )}
        >
          <Icon size={13} />
          {label}
          {selected.size > 0 && (
            <span className="rounded-full bg-foreground/10 px-1.5 text-[10px]">
              {selected.size}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.key}
            checked={selected.has(o.key)}
            onCheckedChange={() => onToggle(o.key)}
            onSelect={(e) => e.preventDefault()}
          >
            <span className="truncate">{o.label}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LayoutToggle({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof List;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} view`}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

/** The board: threads bucketed by status. Dragging a card to another column
 *  persists that status through the thread store (optimistic + server). */
function KanbanBoard({
  items,
  agentById,
  onOpen,
  onMove,
}: {
  items: Task[];
  agentById: Map<string, { id: string; title: string; icon?: string | null }>;
  onOpen: (taskId: string, virtualMcpId?: string) => void;
  onMove: (id: string, lane: Lane) => void;
}) {
  const [overLane, setOverLane] = useState<Lane | null>(null);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {LANES.map((lane) => {
        const laneItems = items.filter((t) => laneFor(t.status) === lane);
        const config = getStatusConfig(lane);
        const LaneIcon = config.icon;
        return (
          <div
            key={lane}
            onDragOver={(e) => {
              e.preventDefault();
              setOverLane(lane);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setOverLane(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain");
              if (id) onMove(id, lane);
              setOverLane(null);
            }}
            className={cn(
              "flex flex-col rounded-xl p-1 transition-colors",
              overLane === lane && "bg-muted/50",
            )}
          >
            <div className="flex items-center gap-2 p-2">
              <LaneIcon
                size={14}
                className={cn("shrink-0", config.iconClassName)}
              />
              <span className="text-xs text-foreground">{config.label}</span>
              <span className="text-[11px] text-muted-foreground">
                {laneItems.length}
              </span>
            </div>
            <div className="flex min-h-12 flex-col gap-2">
              {laneItems.map((t) => (
                <KanbanCard
                  key={t.id}
                  task={t}
                  agent={
                    t.virtual_mcp_id
                      ? agentById.get(t.virtual_mcp_id)
                      : undefined
                  }
                  onOpen={() => onOpen(t.id, t.virtual_mcp_id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskMetaLine({ task }: { task: Task }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/70">
      {task.branch && !isSyntheticBranch(task.branch) && (
        <>
          <span className="truncate font-mono">{task.branch}</span>
          <span className="shrink-0">·</span>
        </>
      )}
      <span className="shrink-0">
        {formatTimeAgo(new Date(task.updated_at))}
      </span>
    </span>
  );
}

function KanbanCard({
  task,
  agent,
  onOpen,
}: {
  task: Task;
  agent?: { title: string; icon?: string | null };
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onOpen}
      className="flex cursor-grab flex-col gap-3 rounded-[10px] border border-border bg-card px-3.5 py-3 text-left transition-colors hover:border-ring/40 active:cursor-grabbing"
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {task.trigger_id && (
            <Zap
              size={12}
              aria-label="Automation-triggered"
              className="shrink-0 text-blue-500"
            />
          )}
          <span className="truncate text-[13px] font-medium leading-snug text-foreground">
            {task.title || "Untitled task"}
          </span>
        </div>
        <AgentAvatar
          icon={agent?.icon ?? null}
          name={agent?.title ?? "Decopilot"}
          size="2xs"
        />
      </div>
      <TaskMetaLine task={task} />
    </button>
  );
}

function ListRow({
  task,
  agent,
  onOpen,
}: {
  task: Task;
  agent?: { title: string; icon?: string | null };
  onOpen: () => void;
}) {
  const config = getStatusConfig(task.status);
  const StatusIcon = config.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-ring/40"
    >
      <StatusIcon
        size={15}
        className={cn(
          "shrink-0",
          config.iconClassName,
          task.status === "in_progress" && "animate-spin",
        )}
      />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {task.trigger_id && (
          <Zap
            size={12}
            aria-label="Automation-triggered"
            className="shrink-0 text-blue-500"
          />
        )}
        <span className="truncate text-sm font-medium text-foreground">
          {task.title || "Untitled task"}
        </span>
      </div>
      <span className={cn("shrink-0 text-xs", config.labelColor)}>
        {config.label}
      </span>
      <AgentAvatar
        icon={agent?.icon ?? null}
        name={agent?.title ?? "Decopilot"}
        size="2xs"
      />
      <TaskMetaLine task={task} />
    </button>
  );
}
