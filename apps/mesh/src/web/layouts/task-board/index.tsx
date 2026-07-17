/**
 * Task board (/$org/board) — the org's own board of tasks (title,
 * description, status, priority, assignee), independent of chat threads.
 * Gated behind the org's task_board_enabled setting (see org settings).
 */

import { useRef, useState } from "react";
import { getInitials } from "@/web/lib/get-initials";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Calendar,
  Columns03,
  HelpCircle,
  List,
  Loading01,
  Plus,
} from "@untitledui/icons";
import { SuperAgentIcon } from "@/web/components/super-agent-icon";
import { useMembers } from "@/web/hooks/use-members";
import {
  useTaskBoardItemActions,
  useTaskBoardItems,
} from "@/web/hooks/use-task-board-items";
import { formatTimeAgo } from "@/web/lib/format-time";
import {
  isTaskBlocked,
  primaryThread,
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
  SUPER_AGENT_ASSIGNEE_ID,
  type TaskBoardItem,
  type TaskBoardItemStatus,
  type Member,
} from "./config";
import { TaskBoardItemDialog } from "./task-dialog";
import { useFlipLanes } from "./use-flip-lanes";
import { usePanelActions } from "@/web/layouts/shell-layout";

// Warm the chat chunk so opening a task's activity doesn't cold-load it (flash).
void import("../agent-shell-layout/index.tsx").catch(() => {});

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

/** Card flag for a task whose agent is paused waiting on human input. */
function BlockedBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
      title="The agent is waiting for your input"
    >
      <HelpCircle size={10} />
      Needs input
    </span>
  );
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

/**
 * Assignee glyph for a card/row. For a Super Agent task it renders the
 * delegation as overlapping avatars — the assigner's avatar eclipsed by the
 * Super Agent capybara — so it's clear a human handed the task off. Otherwise a
 * plain member avatar.
 */
function AssigneeDisplay({
  item,
  assignee,
  assignedBy,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
}) {
  if (item.assigneeId === SUPER_AGENT_ASSIGNEE_ID) {
    return (
      <span
        className="inline-flex items-center"
        title={
          assignedBy?.user?.name
            ? `Assigned to Super Agent by ${assignedBy.user.name}`
            : "Assigned to Super Agent"
        }
      >
        {assignedBy && (
          <Avatar
            url={assignedBy.user?.image ?? undefined}
            fallback={getInitials(assignedBy.user?.name)}
            shape="circle"
            size="2xs"
            className="-mr-1.5 ring-2 ring-background"
          />
        )}
        <SuperAgentIcon size={16} className="ring-2 ring-background" />
      </span>
    );
  }
  if (assignee) {
    return (
      <Avatar
        url={assignee.user?.image ?? undefined}
        fallback={getInitials(assignee.user?.name)}
        shape="circle"
        size="2xs"
      />
    );
  }
  return null;
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
  const { setTaskId } = usePanelActions();

  const openCreate = () => {
    setEditingItem(null);
    setDialogOpen(true);
  };

  const openEdit = (item: TaskBoardItem) => {
    setEditingItem(item);
    setDialogOpen(true);
  };

  // Opening a card always opens the task modal. The modal's activity area is
  // what navigates into the run's chat (see onOpenThread below).
  const openTask = openEdit;

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
        <h1 className="text-xl font-medium text-foreground">Tasks</h1>

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
            onOpen={openTask}
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
                assignedBy={
                  item.assignedBy
                    ? memberByUserId.get(item.assignedBy)
                    : undefined
                }
                onOpen={() => openTask(item)}
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
        onOpenThread={(thread) => {
          if (!thread.virtualMcpId) return;
          setDialogOpen(false);
          setTaskId(thread.threadId, thread.virtualMcpId, {
            main: thread.hasPreview ? "preview" : "board",
          });
        }}
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
  const boardRef = useRef<HTMLDivElement>(null);

  // Re-run FLIP whenever a card's lane or ordering changes.
  const signature = items.map((t) => `${t.id}:${t.status}`).join(",");
  useFlipLanes(boardRef, signature);

  return (
    <div
      ref={boardRef}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
    >
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
                  assignedBy={
                    item.assignedBy
                      ? memberByUserId.get(item.assignedBy)
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
  assignedBy,
  onOpen,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  onOpen: () => void;
}) {
  const priorityConfig = PRIORITY_CONFIG[item.priority];
  const due = item.dueDate ? formatDueDate(item.dueDate) : null;
  const lastMessage = primaryThread(item)?.lastMessage;

  return (
    <button
      type="button"
      draggable
      data-flip-id={item.id}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", item.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onOpen}
      className="flex cursor-grab flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5 text-left transition-colors will-change-transform hover:border-ring/40 active:cursor-grabbing"
      title={item.title}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-snug text-foreground">
          {item.title}
        </span>
        <AssigneeDisplay
          item={item}
          assignee={assignee}
          assignedBy={assignedBy}
        />
      </div>

      {lastMessage && (
        <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          {lastMessage}
        </p>
      )}

      {isTaskBlocked(item) && (
        <div className="flex">
          <BlockedBadge />
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium",
            priorityConfig.badgeClassName,
          )}
        >
          {priorityConfig.label}
        </span>
        {due && (
          <span
            className={cn(
              "text-[11px] text-muted-foreground",
              due.overdue && "text-red-600",
            )}
          >
            {due.label}
          </span>
        )}
      </div>
    </button>
  );
}

function ListRow({
  item,
  assignee,
  assignedBy,
  onOpen,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
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
      {isTaskBlocked(item) && <BlockedBadge />}
      <Badge
        className={cn(
          "shrink-0 text-[10px]",
          PRIORITY_CONFIG[item.priority].badgeClassName,
        )}
      >
        {PRIORITY_CONFIG[item.priority].label}
      </Badge>
      {item.dueDate && <DueDatePill iso={item.dueDate} />}
      <AssigneeDisplay
        item={item}
        assignee={assignee}
        assignedBy={assignedBy}
      />
      <span className="shrink-0 text-[11px] text-muted-foreground/70">
        {formatTimeAgo(new Date(item.createdAt))}
      </span>
    </button>
  );
}
