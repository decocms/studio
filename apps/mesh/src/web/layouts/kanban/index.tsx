/**
 * Kanban board (/$org/kanban) — the org's own board of tasks (title,
 * description, status, priority, assignee), independent of chat threads.
 * Gated behind the org's kanban_enabled setting (see org settings).
 */

import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Columns03, List, Loading01, Plus } from "@untitledui/icons";
import { useMembers } from "@/web/hooks/use-members";
import {
  useKanbanTaskActions,
  useKanbanTasks,
} from "@/web/hooks/use-kanban-tasks";
import { formatTimeAgo } from "@/web/lib/format-time";
import {
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
  type KanbanTask,
  type KanbanTaskStatus,
  type Member,
} from "./config";
import { KanbanTaskDialog } from "./task-dialog";

type Layout = "kanban" | "list";

export default function KanbanBoard() {
  return (
    <div className="min-h-0 flex-1 pt-0 pr-1 pb-1 pl-0">
      <div className="h-full p-0.5 pt-0.25">
        <div className="card-shadow flex h-full flex-col overflow-hidden rounded-[0.75rem] bg-background">
          <KanbanBoardPage />
        </div>
      </div>
    </div>
  );
}

function getInitials(name?: string | null) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function KanbanBoardPage() {
  const { items, isLoading } = useKanbanTasks();
  const actions = useKanbanTaskActions();
  const { data: membersData } = useMembers();
  const members = (membersData?.data?.members ?? []) as Member[];
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  const [layout, setLayout] = useState<Layout>("kanban");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<KanbanTask | null>(null);

  const openCreate = () => {
    setEditingTask(null);
    setDialogOpen(true);
  };

  const openEdit = (task: KanbanTask) => {
    setEditingTask(task);
    setDialogOpen(true);
  };

  if (isLoading && items.length === 0) {
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
        <h1 className="text-xl font-medium text-foreground">Kanban</h1>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={openCreate}>
            <Plus size={16} />
            New task
          </Button>

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
          <KanbanLanes
            items={items}
            memberByUserId={memberByUserId}
            onOpen={openEdit}
            onMove={(id, status) => actions.update.mutate({ id, status })}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((task) => (
              <ListRow
                key={task.id}
                task={task}
                assignee={
                  task.assigneeId
                    ? memberByUserId.get(task.assigneeId)
                    : undefined
                }
                onOpen={() => openEdit(task)}
              />
            ))}
          </div>
        )}
      </div>

      <KanbanTaskDialog
        key={dialogOpen ? (editingTask?.id ?? "new") : "closed"}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        task={editingTask ?? undefined}
        isSaving={actions.create.isPending || actions.update.isPending}
        onSubmit={(input) => {
          if (editingTask) {
            actions.update.mutate({ id: editingTask.id, ...input });
          } else {
            actions.create.mutate(input);
          }
          setDialogOpen(false);
        }}
        onDelete={
          editingTask
            ? () => {
                actions.remove.mutate(editingTask.id);
                setDialogOpen(false);
              }
            : undefined
        }
      />
    </div>
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

function KanbanLanes({
  items,
  memberByUserId,
  onOpen,
  onMove,
}: {
  items: KanbanTask[];
  memberByUserId: Map<string, Member>;
  onOpen: (task: KanbanTask) => void;
  onMove: (id: string, status: KanbanTaskStatus) => void;
}) {
  const [overLane, setOverLane] = useState<KanbanTaskStatus | null>(null);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {STATUSES.map((status) => {
        const laneItems = items.filter((t) => t.status === status);
        const config = STATUS_CONFIG[status];
        const LaneIcon = config.icon;
        return (
          <div
            key={status}
            onDragOver={(e) => {
              e.preventDefault();
              setOverLane(status);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setOverLane(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain");
              if (id) onMove(id, status);
              setOverLane(null);
            }}
            className={cn(
              "flex flex-col rounded-xl p-1 transition-colors",
              overLane === status && "bg-muted/50",
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
              {laneItems.map((task) => (
                <KanbanCard
                  key={task.id}
                  task={task}
                  assignee={
                    task.assigneeId
                      ? memberByUserId.get(task.assigneeId)
                      : undefined
                  }
                  onOpen={() => onOpen(task)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({
  task,
  assignee,
  onOpen,
}: {
  task: KanbanTask;
  assignee?: Member;
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
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-snug text-foreground">
          {task.title}
        </span>
        {assignee && (
          <Avatar
            url={assignee.user?.image ?? undefined}
            fallback={getInitials(assignee.user?.name)}
            shape="circle"
            size="2xs"
          />
        )}
      </div>
      <div className="flex items-center gap-2">
        <Badge
          className={cn(
            "text-[10px]",
            PRIORITY_CONFIG[task.priority].badgeClassName,
          )}
        >
          {PRIORITY_CONFIG[task.priority].label}
        </Badge>
        <span className="text-[11px] text-muted-foreground/70">
          {formatTimeAgo(new Date(task.createdAt))}
        </span>
      </div>
    </button>
  );
}

function ListRow({
  task,
  assignee,
  onOpen,
}: {
  task: KanbanTask;
  assignee?: Member;
  onOpen: () => void;
}) {
  const config = STATUS_CONFIG[task.status];
  const StatusIcon = config.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-ring/40"
    >
      <StatusIcon size={15} className={cn("shrink-0", config.iconClassName)} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {task.title}
      </span>
      <Badge
        className={cn(
          "shrink-0 text-[10px]",
          PRIORITY_CONFIG[task.priority].badgeClassName,
        )}
      >
        {PRIORITY_CONFIG[task.priority].label}
      </Badge>
      {assignee && (
        <Avatar
          url={assignee.user?.image ?? undefined}
          fallback={getInitials(assignee.user?.name)}
          shape="circle"
          size="2xs"
        />
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground/70">
        {formatTimeAgo(new Date(task.createdAt))}
      </span>
    </button>
  );
}
