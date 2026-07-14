/**
 * Task board (/$org/board) — the org's own board of tasks (title,
 * description, status, priority, assignee), independent of chat threads.
 * Gated behind the org's task_board_enabled setting (see org settings).
 */

import { useState } from "react";
import { getInitials } from "@/web/lib/get-initials";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Calendar,
  Columns03,
  Flag01,
  List,
  Loading01,
  Plus,
  User01,
} from "@untitledui/icons";
import { useMembers } from "@/web/hooks/use-members";
import {
  useTaskBoardItemActions,
  useTaskBoardItems,
} from "@/web/hooks/use-task-board-items";
import { formatTimeAgo } from "@/web/lib/format-time";
import {
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
  type TaskBoardItem,
  type TaskBoardItemStatus,
  type Member,
} from "./config";
import { TaskBoardItemDialog } from "./task-dialog";

type Layout = "board" | "list";

export default function TaskBoard() {
  return (
    <div className="min-h-0 flex-1 pt-0 pr-1 pb-1 pl-0">
      <div className="h-full p-0.5 pt-0.25">
        <div className="card-shadow flex h-full flex-col overflow-hidden rounded-[0.75rem] bg-background">
          <TaskBoardPage />
        </div>
      </div>
    </div>
  );
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function formatDueDate(iso: string): { label: string; overdue: boolean } {
  const d = new Date(iso);
  const overdue = d.getTime() < Date.now();
  return { label: DATE_FMT.format(d), overdue };
}

function DueDatePill({ iso }: { iso: string }) {
  const { label, overdue } = formatDueDate(iso);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]",
        overdue
          ? "bg-red-500/10 text-red-600"
          : "bg-muted text-muted-foreground",
      )}
    >
      <Calendar size={10} />
      {label}
    </span>
  );
}

export function TaskBoardPage() {
  const { items, isLoading } = useTaskBoardItems();
  const actions = useTaskBoardItemActions();
  const { data: membersData } = useMembers();
  const members = (membersData?.data?.members ?? []) as Member[];
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  const [layout, setLayout] = useState<Layout>("board");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<TaskBoardItem | null>(null);

  const openCreate = () => {
    setEditingItem(null);
    setDialogOpen(true);
  };

  const openEdit = (item: TaskBoardItem) => {
    setEditingItem(item);
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
          layout === "board" ? "max-w-[1400px]" : "max-w-[900px]",
        )}
      >
        <h1 className="text-xl font-medium text-foreground">Board</h1>

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
              active={layout === "board"}
              onClick={() => setLayout("board")}
              icon={Columns03}
              label="Board"
            />
          </div>
        </div>

        {items.length === 0 ? (
          <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
            No tasks yet. Start one with New task.
          </div>
        ) : layout === "board" ? (
          <Lanes
            items={items}
            memberByUserId={memberByUserId}
            onOpen={openEdit}
            onMove={(id, status) => actions.update.mutate({ id, status })}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <ListRow
                key={item.id}
                item={item}
                assignee={
                  item.assigneeId
                    ? memberByUserId.get(item.assigneeId)
                    : undefined
                }
                onOpen={() => openEdit(item)}
              />
            ))}
          </div>
        )}
      </div>

      <TaskBoardItemDialog
        key={dialogOpen ? (editingItem?.id ?? "new") : "closed"}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        item={editingItem ?? undefined}
        isSaving={actions.create.isPending || actions.update.isPending}
        onSubmit={(input) => {
          if (editingItem) {
            actions.update.mutate({ id: editingItem.id, ...input });
          } else {
            actions.create.mutate(input);
          }
          setDialogOpen(false);
        }}
        onDelete={
          editingItem
            ? () => {
                actions.remove.mutate(editingItem.id);
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

function Lanes({
  items,
  memberByUserId,
  onOpen,
  onMove,
}: {
  items: TaskBoardItem[];
  memberByUserId: Map<string, Member>;
  onOpen: (item: TaskBoardItem) => void;
  onMove: (id: string, status: TaskBoardItemStatus) => void;
}) {
  const [overLane, setOverLane] = useState<TaskBoardItemStatus | null>(null);

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
              {laneItems.map((item) => (
                <TaskCard
                  key={item.id}
                  item={item}
                  assignee={
                    item.assigneeId
                      ? memberByUserId.get(item.assigneeId)
                      : undefined
                  }
                  onOpen={() => onOpen(item)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskCard({
  item,
  assignee,
  onOpen,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  onOpen: () => void;
}) {
  const priorityConfig = PRIORITY_CONFIG[item.priority];
  const due = item.dueDate ? formatDueDate(item.dueDate) : null;

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", item.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onOpen}
      className="flex cursor-grab flex-col gap-2.5 rounded-[10px] border border-border bg-card px-3.5 py-3 text-left transition-colors hover:border-ring/40 active:cursor-grabbing"
    >
      <span className="min-w-0 truncate text-[13px] font-medium leading-snug text-foreground">
        {item.title}
      </span>

      <div className="flex flex-col gap-1.5 text-[12px] text-muted-foreground">
        <CardMetaRow
          icon={
            assignee ? (
              <Avatar
                url={assignee.user?.image ?? undefined}
                fallback={getInitials(assignee.user?.name)}
                shape="circle"
                size="2xs"
              />
            ) : (
              <User01 size={13} className="text-muted-foreground/60" />
            )
          }
          value={assignee?.user?.name}
        />
        <CardMetaRow
          icon={
            <Calendar
              size={13}
              className={cn(
                due?.overdue ? "text-red-500" : "text-muted-foreground/60",
              )}
            />
          }
          value={due?.label}
          valueClassName={due?.overdue ? "text-red-600" : undefined}
        />
        <CardMetaRow
          icon={<Flag01 size={13} className={priorityConfig.flagClassName} />}
          value={priorityConfig.label}
        />
      </div>

      <span className="text-[10px] text-muted-foreground/60">
        {formatTimeAgo(new Date(item.createdAt))}
      </span>
    </button>
  );
}

function CardMetaRow({
  icon,
  value,
  valueClassName,
}: {
  icon: React.ReactNode;
  value?: string | null;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span
        className={cn(
          "min-w-0 truncate",
          value ? valueClassName : "text-muted-foreground/50",
        )}
      >
        {value ?? "—"}
      </span>
    </div>
  );
}

function ListRow({
  item,
  assignee,
  onOpen,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  onOpen: () => void;
}) {
  const config = STATUS_CONFIG[item.status];
  const StatusIcon = config.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-ring/40"
    >
      <StatusIcon size={15} className={cn("shrink-0", config.iconClassName)} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {item.title}
      </span>
      <Badge
        className={cn(
          "shrink-0 text-[10px]",
          PRIORITY_CONFIG[item.priority].badgeClassName,
        )}
      >
        {PRIORITY_CONFIG[item.priority].label}
      </Badge>
      {item.dueDate && <DueDatePill iso={item.dueDate} />}
      {assignee && (
        <Avatar
          url={assignee.user?.image ?? undefined}
          fallback={getInitials(assignee.user?.name)}
          shape="circle"
          size="2xs"
        />
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground/70">
        {formatTimeAgo(new Date(item.createdAt))}
      </span>
    </button>
  );
}
