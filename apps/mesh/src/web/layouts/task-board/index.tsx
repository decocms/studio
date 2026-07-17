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
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type Member,
} from "./config";
import { TaskBoardItemDialog } from "./task-dialog";
import {
  EMPTY_FILTERS,
  TaskFiltersBar,
  taskMatchesFilters,
  type TaskFilters,
} from "./task-filters";
import { useFlipLanes } from "./use-flip-lanes";
import { usePanelActions } from "@/web/layouts/shell-layout";

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

/**
 * Shared meta chip: outlined (border, no fill), lightly rounded (not a full
 * pill), with room for a larger leading icon.
 */
const PILL =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground";

/** Card flag for a task whose agent is paused waiting on human input. */
function BlockedBadge() {
  return (
    <span
      className={cn(PILL, "border-amber-500/30 text-amber-600")}
      title="The agent is waiting for your input"
    >
      <HelpCircle size={14} />
      Needs input
    </span>
  );
}

function PriorityPill({ priority }: { priority: TaskBoardItemPriority }) {
  const config = PRIORITY_CONFIG[priority];
  return (
    <span className={PILL}>
      <span className={cn("size-2 rounded-full", config.dotClassName)} />
      {config.label}
    </span>
  );
}

function DueDatePill({ iso }: { iso: string }) {
  const { label, overdue } = formatDueDate(iso);
  return (
    <span
      className={cn(PILL, overdue && "border-destructive/30 text-destructive")}
    >
      <Calendar size={14} />
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
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<TaskBoardItem | null>(null);
  // Status a newly-created task should start in (set by a lane's "+"); null for
  // the generic "New task" button.
  const [createStatus, setCreateStatus] = useState<TaskBoardItemStatus | null>(
    null,
  );
  const { setTaskId } = usePanelActions();

  const visibleItems = items.filter((item) =>
    taskMatchesFilters(item, filters),
  );

  const openCreate = () => {
    setEditingItem(null);
    setCreateStatus(null);
    setDialogOpen(true);
  };

  const openCreateInLane = (status: TaskBoardItemStatus) => {
    setEditingItem(null);
    setCreateStatus(status);
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
    // Cap the whole page (header + board/list) and center it so content
    // doesn't stretch edge-to-edge on wide monitors; the panel background
    // still spans full width. Board lanes scroll horizontally within this cap.
    <div className="mx-auto flex min-h-0 w-full max-w-[1680px] flex-1 flex-col">
      {/* Header — shares the board/list left edge so the two views line up. */}
      <div className="flex flex-col gap-4 px-4 pt-6 sm:px-8 sm:pt-8">
        <h1 className="text-xl font-medium text-foreground">Tasks</h1>

        {/* Toolbar — filters on the left, view toggle + New task aligned to
            their right. Controls take their own full-width row on mobile. */}
        <div className="flex flex-wrap items-center gap-2">
          {items.length > 0 && (
            <TaskFiltersBar
              filters={filters}
              members={members}
              onChange={setFilters}
            />
          )}

          <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-end">
            <div className="inline-flex rounded-lg bg-muted p-0.5">
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

            <Button size="sm" onClick={openCreate}>
              <Plus size={16} />
              New task
            </Button>
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="px-4 pt-6 sm:px-8">
          <div className="rounded-xl bg-card px-4 py-12 text-center text-sm text-muted-foreground card-shadow">
            No tasks yet. Start one with New task.
          </div>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="px-4 pt-6 sm:px-8">
          <div className="flex flex-col items-center gap-3 rounded-xl bg-card px-4 py-12 text-center text-sm text-muted-foreground card-shadow">
            No tasks match these filters.
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters(EMPTY_FILTERS)}
            >
              Clear filters
            </Button>
          </div>
        </div>
      ) : layout === "board" ? (
        <Lanes
          items={visibleItems}
          memberByUserId={memberByUserId}
          onOpen={openTask}
          onCreate={openCreateInLane}
          onMove={(id, status) => actions.update.mutate({ id, status })}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-6 pb-16 sm:px-8">
          <div className="mx-auto flex max-w-[820px] flex-col gap-2">
            {visibleItems.map((item) => (
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
        </div>
      )}

      <TaskBoardItemDialog
        key={
          dialogOpen
            ? (editingItem?.id ?? `new-${createStatus ?? "default"}`)
            : "closed"
        }
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        item={editingItem ?? undefined}
        defaultStatus={createStatus ?? undefined}
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
  onCreate,
  onMove,
}: {
  items: TaskBoardItem[];
  memberByUserId: Map<string, Member>;
  onOpen: (item: TaskBoardItem) => void;
  onCreate: (status: TaskBoardItemStatus) => void;
  onMove: (id: string, status: TaskBoardItemStatus) => void;
}) {
  const [overLane, setOverLane] = useState<TaskBoardItemStatus | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  // Re-run FLIP whenever a card's lane or ordering changes.
  const signature = items.map((t) => `${t.id}:${t.status}`).join(",");
  useFlipLanes(boardRef, signature);

  return (
    // A kanban isn't fit-width: lanes keep a comfortable fixed width and the
    // board scrolls horizontally when they don't all fit (incl. mobile).
    <div
      ref={boardRef}
      className="flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-auto px-4 pt-6 pb-16 sm:px-8"
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
              "flex w-[300px] shrink-0 flex-col rounded-xl p-1 transition-colors",
              overLane === status && "bg-muted/50",
            )}
          >
            <div className="flex items-center gap-2 px-2 py-1.5">
              <LaneIcon
                size={15}
                className={cn("shrink-0", config.iconClassName)}
              />
              <span className="text-sm font-medium text-foreground">
                {config.label}
              </span>
              <span className="rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">
                {laneItems.length}
              </span>
              <button
                type="button"
                aria-label={`New task in ${config.label}`}
                title={`New task in ${config.label}`}
                onClick={() => onCreate(status)}
                className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="flex min-h-12 flex-col gap-2 pt-1">
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
  const statusConfig = STATUS_CONFIG[item.status];
  const StatusIcon = statusConfig.icon;
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
      className="group flex cursor-grab flex-col gap-2 rounded-xl bg-card px-3 py-2.5 text-left card-shadow transition-colors will-change-transform hover:bg-accent/60 active:cursor-grabbing"
      title={item.title}
    >
      <div className="flex items-start gap-2">
        <StatusIcon
          size={16}
          className={cn("mt-px shrink-0", statusConfig.iconClassName)}
        />
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground line-clamp-2">
          {item.title}
        </span>
        <AssigneeDisplay
          item={item}
          assignee={assignee}
          assignedBy={assignedBy}
        />
      </div>

      {lastMessage && (
        <p className="line-clamp-2 pl-6 text-xs leading-snug text-muted-foreground">
          {lastMessage}
        </p>
      )}

      {(isTaskBlocked(item) ||
        item.priority !== "none" ||
        Boolean(item.dueDate)) && (
        <div className="flex flex-wrap items-center gap-1.5 pl-6">
          {isTaskBlocked(item) && <BlockedBadge />}
          {item.priority !== "none" && (
            <PriorityPill priority={item.priority} />
          )}
          {item.dueDate && <DueDatePill iso={item.dueDate} />}
        </div>
      )}
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
      className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-left card-shadow transition-colors hover:bg-accent/60"
    >
      <StatusIcon size={16} className={cn("shrink-0", config.iconClassName)} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {item.title}
      </span>
      {isTaskBlocked(item) && <BlockedBadge />}
      {item.priority !== "none" && (
        <span className="hidden sm:inline-flex">
          <PriorityPill priority={item.priority} />
        </span>
      )}
      {item.dueDate && (
        <span className="hidden sm:inline-flex">
          <DueDatePill iso={item.dueDate} />
        </span>
      )}
      <AssigneeDisplay
        item={item}
        assignee={assignee}
        assignedBy={assignedBy}
      />
      <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline">
        {formatTimeAgo(new Date(item.createdAt))}
      </span>
    </button>
  );
}
