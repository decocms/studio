/**
 * Epics and subtasks: one parent relation over ordinary cards (`parentId`,
 * `isEpic`). An epic is a card marked as one; a card under an epic still rides
 * the board, while a card under any other card is that card's subtask and
 * lives inside it. The API enforces the nesting rules.
 */

import { createContext, use, useState, type ReactNode } from "react";
import {
  AlertOctagon,
  ChevronDown,
  Dataflow03,
  Lightning01,
  Plus,
} from "@untitledui/icons";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import { taskKey } from "@decocms/shared/task-key";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { runningAgents } from "@/components/org-home/daily-pulse";
import { TaskAssigneeAvatar } from "@/components/task-assignee-avatar";
import { useT } from "@/i18n/use-t.ts";
import {
  agentRunState,
  DEFAULT_TASK_TYPE,
  isCriticalTask,
  isTaskBlocked,
  laneHeader,
  laneVisual,
  PRIORITY_CONFIG,
  TASK_TYPE_CONFIG,
  type Member,
  type TaskBoardItem,
} from "./config";

type Segment = "done" | "active" | "todo";

function segmentOf(status: TaskBoardItem["status"]): Segment | null {
  switch (status) {
    case "done":
      return "done";
    case "archived":
      return null;
    case "triage":
    case "todo":
      return "todo";
    case "in_progress":
    case "in_review":
    case "qa":
    case "customer_approval":
    case "ready_for_deployment":
    case "post_deploy_validation":
      return "active";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

interface Progress {
  done: number;
  active: number;
  todo: number;
  total: number;
}

/** Archived children drop out: shelved work is neither done nor left to do. */
export function progressOf(children: readonly TaskBoardItem[]): Progress {
  const progress: Progress = { done: 0, active: 0, todo: 0, total: 0 };
  for (const child of children) {
    const segment = segmentOf(child.status);
    if (!segment) continue;
    progress[segment] += 1;
    progress.total += 1;
  }
  return progress;
}

/** The lane an epic reads as, from its cards: all done, any started, or none. */
export function epicStatus(progress: Progress): TaskBoardItem["status"] {
  if (progress.total > 0 && progress.done === progress.total) return "done";
  if (progress.active > 0 || progress.done > 0) return "in_progress";
  return "todo";
}

export function childrenOf(
  items: readonly TaskBoardItem[],
  id: string,
): TaskBoardItem[] {
  return items.filter((item) => item.parentId === id);
}

/** The card `item` sits under. A parent no longer on the board (deleted,
 *  dismissed) reads as none, so the card shows at the top level. */
function parentOf(
  items: readonly TaskBoardItem[],
  item: TaskBoardItem,
): TaskBoardItem | undefined {
  return item.parentId
    ? items.find((other) => other.id === item.parentId)
    : undefined;
}

/** Whether `item` is a subtask: under a card that is not an epic. */
export function isSubtask(
  items: readonly TaskBoardItem[],
  item: TaskBoardItem,
): boolean {
  const parent = parentOf(items, item);
  return !!parent && !parent.isEpic;
}

/** A subtask the lanes still show: one waiting on a person or with a failed
 *  run must not hide behind its parent's progress pill. */
function subtaskNeedsAttention(item: TaskBoardItem): boolean {
  if (item.status === "done" || item.status === "archived") return false;
  return isTaskBlocked(item) || agentRunState(item) === "failed";
}

/** The cards the lanes draw: subtasks stay inside their parent unless they
 *  need attention, and an epic rides the lane its cards put it in rather than
 *  the one it was saved in. An archived epic stays archived. */
export function laneCards(
  visible: readonly TaskBoardItem[],
  all: readonly TaskBoardItem[],
): TaskBoardItem[] {
  return visible.flatMap((item) => {
    if (item.isEpic) {
      if (item.status === "archived") return [item];
      const status = epicStatus(progressOf(childrenOf(all, item.id)));
      return [{ ...item, status }];
    }
    return isSubtask(all, item) && !subtaskNeedsAttention(item) ? [] : [item];
  });
}

interface EpicBoard {
  items: readonly TaskBoardItem[];
  memberByUserId: ReadonlyMap<string, Member>;
  onSetStatus: (id: string, status: TaskBoardItem["status"]) => void;
  orgSlug: string;
  setParent: (id: string, parentId: string | null) => void;
  setEpic: (id: string, epic: boolean) => void;
  onOpen: (item: TaskBoardItem) => void;
  /** Back to the board's Epics tab. */
  onShowEpics: () => void;
  /** Files a new card under `parent`, in the parent's project. */
  onCreateChild: (parent: TaskBoardItem, title: string) => void;
}

const EpicBoardContext = createContext<EpicBoard | null>(null);

/** Null outside a board, so a card rendered elsewhere simply shows no hierarchy. */
export function useEpicBoard(): EpicBoard | null {
  return use(EpicBoardContext);
}

export function EpicBoardProvider({
  value,
  children,
}: {
  /** Null keeps the hierarchy off: no pills, no sheet sections. */
  value: EpicBoard | null;
  children: ReactNode;
}) {
  return <EpicBoardContext value={value}>{children}</EpicBoardContext>;
}

/** Done, in flight, not started: one bar, three widths. */
function ProgressBar({
  progress,
  className,
}: {
  progress: Progress;
  className?: string;
}) {
  const width = (n: number) =>
    progress.total === 0 ? "0%" : `${(n / progress.total) * 100}%`;
  return (
    <div
      className={cn(
        "flex h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      <div className="bg-success" style={{ width: width(progress.done) }} />
      <div className="bg-chart-1" style={{ width: width(progress.active) }} />
    </div>
  );
}

/** The epic a card belongs to, in the card's pill row. */
export function EpicPill({ item }: { item: TaskBoardItem }) {
  const board = useEpicBoard();
  if (!board) return null;
  const epic = parentOf(board.items, item);
  if (!epic?.isEpic) return null;
  return (
    <span
      title={epic.title}
      className="inline-flex h-5 max-w-40 items-center gap-1 rounded-md bg-chart-1/15 px-1.5 text-xs font-medium text-foreground"
    >
      <Lightning01 size={11} className="shrink-0 text-chart-1" />
      <span className="truncate">{epic.title}</span>
    </span>
  );
}

/** On an epic's board card: that it is one, and how far its cards are. */
export function EpicProgressPill({ item }: { item: TaskBoardItem }) {
  const t = useT();
  const board = useEpicBoard();
  if (!board || !item.isEpic) return null;
  const progress = progressOf(childrenOf(board.items, item.id));
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded-md bg-chart-1/15 px-1.5 text-xs font-medium text-foreground">
      <Lightning01 size={11} className="shrink-0 text-chart-1" />
      {t("taskBoard.epics.epicBadge")}
      <ProgressBar progress={progress} className="w-10" />
      <span className="tabular-nums text-muted-foreground">
        {progress.done}/{progress.total}
      </span>
    </span>
  );
}

/** `2/5` subtasks done, on a card that has any. */
export function SubtaskPill({ item }: { item: TaskBoardItem }) {
  const t = useT();
  const board = useEpicBoard();
  if (!board || item.isEpic) return null;
  const progress = progressOf(childrenOf(board.items, item.id));
  if (progress.total === 0) return null;
  return (
    <span
      title={t("taskBoard.epics.subtasks")}
      className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground"
    >
      <Dataflow03 size={11} className="shrink-0" />
      {progress.done}/{progress.total}
    </span>
  );
}

/** The Epics tab: every epic with how far along it is. */
export function EpicsView() {
  const t = useT();
  const board = useEpicBoard();
  if (!board) return null;
  const epics = board.items.filter((item) => item.isEpic);

  if (epics.length === 0) {
    return (
      <div className="surface px-4 py-12 text-center text-sm text-muted-foreground">
        {t("taskBoard.epics.empty")}
      </div>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {epics.map((epic) => (
        <EpicCard
          key={epic.id}
          epic={epic}
          workItems={childrenOf(board.items, epic.id)}
          board={board}
        />
      ))}
    </div>
  );
}

/** An epic at a glance: what it is, how far along, and what needs a look. */
function EpicCard({
  epic,
  workItems,
  board,
}: {
  epic: TaskBoardItem;
  workItems: TaskBoardItem[];
  board: EpicBoard;
}) {
  const t = useT();
  const progress = progressOf(workItems);
  const status = epicStatus(progress);
  const chipClassName = statusChipClass(status === "done");
  const running = runningAgents(workItems).length;
  const critical = workItems.filter(isCriticalTask).length;
  const percent =
    progress.total === 0
      ? 0
      : Math.round((progress.done / progress.total) * 100);
  const assigneeIds = [
    ...new Set(
      workItems.flatMap((item) => (item.assigneeId ? [item.assigneeId] : [])),
    ),
  ];

  return (
    <button
      type="button"
      onClick={() => board.onOpen(epic)}
      className="surface flex w-full flex-col gap-4 p-4 text-left transition-colors hover:bg-accent"
    >
      <div className="flex items-start gap-3">
        <Lightning01 size={16} className="mt-0.5 shrink-0 text-chart-1" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">
            {epic.title}
          </span>
          <span className="text-xs text-muted-foreground">
            {taskKey(board.orgSlug, epic.keySeq)}
            {" · "}
            {progress.total === 1
              ? t("taskBoard.epics.cardCountOne")
              : t("taskBoard.epics.cardCountMany", { count: progress.total })}
          </span>
        </div>
        <span className={chipClassName}>
          <StatusGlyph status={status} />
          {laneHeader(status, t).label}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <ProgressBar progress={progress} className="flex-1" />
        <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">
          {percent}%
        </span>
      </div>

      <div className="flex min-h-5 items-center gap-4 text-xs text-muted-foreground">
        <SegmentCount className="bg-success" count={progress.done}>
          {t("taskBoard.epics.segmentDone")}
        </SegmentCount>
        <SegmentCount className="bg-chart-1" count={progress.active}>
          {t("taskBoard.epics.segmentActive")}
        </SegmentCount>
        <SegmentCount className="bg-muted-foreground/30" count={progress.todo}>
          {t("taskBoard.epics.segmentTodo")}
        </SegmentCount>
        <span className="ml-auto flex items-center gap-3">
          {critical > 0 && (
            <span
              title={t("taskBoard.taskBoard.swimlaneCritical")}
              className="inline-flex items-center gap-1 text-destructive"
            >
              <AlertOctagon size={13} />
              <span className="tabular-nums">{critical}</span>
            </span>
          )}
          {running > 0 && (
            <span
              title={
                running === 1
                  ? t("taskBoard.taskBoard.agentsRunningOne")
                  : t("taskBoard.taskBoard.agentsRunningMany", {
                      count: running,
                    })
              }
              className="inline-flex items-center gap-1 text-foreground"
            >
              <Spinner className="size-3" />
              <span className="tabular-nums">{running}</span>
            </span>
          )}
          {assigneeIds.length > 0 && (
            <span className="flex -space-x-1.5">
              {assigneeIds.slice(0, 3).map((id) => (
                <TaskAssigneeAvatar
                  key={id}
                  assigneeId={id}
                  assignee={board.memberByUserId.get(id)}
                  size={18}
                  className="rounded-full ring-2 ring-card"
                />
              ))}
            </span>
          )}
        </span>
      </div>
    </button>
  );
}

function SegmentCount({
  className,
  count,
  children,
}: {
  className: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-2 rounded-full", className)} />
      <span className="tabular-nums text-foreground">{count}</span>
      {children}
    </span>
  );
}

/** The lane's own icon, still: a chip names a state, it is not busy. */
function StatusGlyph({ status }: { status: string }) {
  const visual = laneVisual(status);
  const Icon = visual.icon;
  return (
    <Icon
      size={12}
      aria-hidden
      className={cn(
        "shrink-0",
        visual.iconClassName.replace(/\banimate-\S+\b/g, "").trim(),
      )}
    />
  );
}

/** A status read out as a chip: green once done. */
function statusChipClass(done: boolean) {
  return cn(
    "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
    done
      ? "bg-success/15 text-success hover:bg-success/25"
      : "bg-muted text-foreground hover:bg-secondary-hover",
  );
}

/** The card sheet's Parent property: pick an epic, or make this card one. */
export function ParentProperty({
  item,
  buttonClassName,
}: {
  item: TaskBoardItem;
  buttonClassName: string;
}) {
  const t = useT();
  const board = useEpicBoard();
  if (!board) return null;
  const isEpic = item.isEpic;
  const parent = parentOf(board.items, item);
  const epics = board.items.filter((i) => i.isEpic && i.id !== item.id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(buttonClassName, "max-w-full")}>
          {isEpic ? (
            <>
              <Lightning01 size={16} className="shrink-0 text-chart-1" />
              {t("taskBoard.epics.epicBadge")}
            </>
          ) : parent ? (
            <>
              {parent.isEpic ? (
                <Lightning01 size={16} className="shrink-0 text-chart-1" />
              ) : (
                <Dataflow03 size={16} className="shrink-0" />
              )}
              <span className="min-w-0 truncate">{parent.title}</span>
            </>
          ) : (
            <>
              <Dataflow03 size={16} className="shrink-0" />
              {t("taskBoard.epics.addParent")}
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {isEpic ? (
          <DropdownMenuItem onSelect={() => board.setEpic(item.id, false)}>
            {t("taskBoard.epics.makeCard")}
          </DropdownMenuItem>
        ) : (
          <>
            {parent && (
              <DropdownMenuItem onSelect={() => board.setParent(item.id, null)}>
                {t("taskBoard.epics.noParent")}
              </DropdownMenuItem>
            )}
            {epics.map((epic) => (
              <DropdownMenuItem
                key={epic.id}
                className="gap-2"
                onSelect={() => board.setParent(item.id, epic.id)}
              >
                <Lightning01 size={14} className="shrink-0 text-chart-1" />
                <span className="truncate">{epic.title}</span>
              </DropdownMenuItem>
            ))}
            {(parent || epics.length > 0) && <DropdownMenuSeparator />}
            <DropdownMenuItem
              className="gap-2"
              onSelect={() => board.setEpic(item.id, true)}
            >
              <Lightning01 size={14} className="shrink-0" />
              {t("taskBoard.epics.makeEpic")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The cards under this one, in the sheet's main column: an epic's work items,
 *  or a card's subtasks. Hidden on a subtask, which goes no deeper. */
export function ChildrenSection({ item }: { item: TaskBoardItem }) {
  const t = useT();
  const board = useEpicBoard();
  const [draft, setDraft] = useState("");
  if (!board) return null;
  const isEpic = item.isEpic;
  if (isSubtask(board.items, item)) return null;

  const children = childrenOf(board.items, item.id);
  const progress = progressOf(children);
  const candidates = isEpic
    ? board.items.filter(
        (i) =>
          i.id !== item.id &&
          !i.isEpic &&
          !parentOf(board.items, i) &&
          i.status !== "archived",
      )
    : [];

  const submit = () => {
    const title = draft.trim();
    if (!title) return;
    board.onCreateChild(item, title);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-3 pb-6">
      <div className="flex items-center gap-3">
        <span className="text-base font-semibold text-foreground">
          {t(isEpic ? "taskBoard.epics.workItems" : "taskBoard.epics.subtasks")}
        </span>
        {progress.total > 0 && (
          <>
            <ProgressBar progress={progress} className="max-w-40" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("taskBoard.epics.progress", {
                done: progress.done,
                total: progress.total,
              })}
            </span>
          </>
        )}
        {candidates.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="ml-auto">
                {t("taskBoard.epics.addExisting")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-h-80 w-72 overflow-y-auto"
            >
              {candidates.map((candidate) => (
                <DropdownMenuItem
                  key={candidate.id}
                  onSelect={() => board.setParent(candidate.id, item.id)}
                >
                  <span className="truncate">{candidate.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="surface flex flex-col overflow-hidden">
        {children.map((child) => (
          <ChildRow key={child.id} child={child} board={board} />
        ))}
        <div className="flex items-center gap-3 px-3 py-2.5">
          <Plus size={15} className="shrink-0 text-muted-foreground" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={t(
              isEpic
                ? "taskBoard.epics.addWorkItemPlaceholder"
                : "taskBoard.epics.addSubtaskPlaceholder",
            )}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
    </div>
  );
}

/** Statuses a child can be moved to from its row. */
const CHILD_STATUSES = CANONICAL_COLUMN_KEYS.filter(
  (key) => key !== "archived",
);

/** One child, the way a tracker lists linked work: what it is, its key, its
 *  title, then status, owner and priority. Done reads as struck through. */
function ChildRow({
  child,
  board,
}: {
  child: TaskBoardItem;
  board: EpicBoard;
}) {
  const t = useT();
  const type = TASK_TYPE_CONFIG[child.type ?? DEFAULT_TASK_TYPE];
  const TypeIcon = type.icon;
  const priority = PRIORITY_CONFIG[child.priority];
  const PriorityIcon = priority.icon;
  const isEpic = child.isEpic;
  // An epic's status is its cards', so its row reports it rather than offering it.
  const statusKey = isEpic
    ? epicStatus(progressOf(childrenOf(board.items, child.id)))
    : child.status;
  const status = laneHeader(statusKey, t);
  const done = statusKey === "done";
  const chipClassName = statusChipClass(done);
  const assignee = child.assigneeId
    ? board.memberByUserId.get(child.assigneeId)
    : undefined;

  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-border px-3 py-2 transition-colors last:border-b-0 hover:bg-accent">
      {isEpic ? (
        <Lightning01
          size={15}
          aria-label={t("taskBoard.epics.epicBadge")}
          className="shrink-0 text-chart-1"
        />
      ) : (
        <TypeIcon
          size={15}
          aria-label={t(type.labelKey)}
          className={cn("shrink-0", type.iconClassName)}
        />
      )}
      <button
        type="button"
        onClick={() => board.onOpen(child)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span
          className={cn(
            "shrink-0 text-sm text-muted-foreground",
            done && "line-through",
          )}
        >
          {taskKey(board.orgSlug, child.keySeq)}
        </span>
        <span className="min-w-0 truncate text-sm text-foreground">
          {child.title}
        </span>
      </button>
      {/* Fixed width, start-aligned: every row's status starts in the same column. */}
      <div className="flex w-44 shrink-0 justify-start">
        {isEpic ? (
          <span className={chipClassName}>
            <StatusGlyph status={statusKey} />
            {status.label}
          </span>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={chipClassName}>
                <StatusGlyph status={statusKey} />
                {status.label}
                <ChevronDown size={12} className="shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {CHILD_STATUSES.map((key) => {
                const lane = laneHeader(key, t);
                const LaneIcon = lane.visual.icon;
                return (
                  <DropdownMenuItem
                    key={key}
                    className="gap-2"
                    onSelect={() => board.onSetStatus(child.id, key)}
                  >
                    <LaneIcon
                      size={14}
                      className={cn(
                        "shrink-0",
                        lane.visual.iconClassName
                          .replace(/\banimate-\S+\b/g, "")
                          .trim(),
                      )}
                    />
                    {lane.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <span className="flex w-5 shrink-0 justify-center">
        <TaskAssigneeAvatar
          assigneeId={child.assigneeId}
          assignee={assignee}
          title={assignee?.user?.name ?? undefined}
        />
      </span>
      <PriorityIcon
        size={15}
        aria-label={t(priority.labelKey)}
        className={cn("shrink-0", priority.iconClassName)}
      />
    </div>
  );
}

/** In a child's sheet, laid out like the Subtasks section: the epic or card
 *  it belongs to. */
export function ParentSection({ item }: { item: TaskBoardItem }) {
  const t = useT();
  const board = useEpicBoard();
  if (!board) return null;
  const parent = parentOf(board.items, item);
  if (!parent) return null;
  const isEpic = parent.isEpic;

  return (
    <div className="flex flex-col gap-3 pb-6">
      <span className="text-base font-semibold text-foreground">
        {t(isEpic ? "taskBoard.epics.epicBadge" : "taskBoard.epics.parentTask")}
      </span>
      <div className="surface flex flex-col overflow-hidden">
        <ChildRow child={parent} board={board} />
      </div>
    </div>
  );
}

/** The breadcrumb step between Tasks and this card: its parent, or the Epics
 *  tab when the card is an epic. */
export function useHierarchyCrumb(
  item: TaskBoardItem | undefined,
): { key: string; label: string; onSelect: () => void } | null {
  const t = useT();
  const board = useEpicBoard();
  if (!board || !item) return null;
  if (item.isEpic) {
    return {
      key: "epics",
      label: t("taskBoard.epics.tab"),
      onSelect: board.onShowEpics,
    };
  }
  const parent = parentOf(board.items, item);
  if (!parent) return null;
  return {
    key: "parent",
    label: taskKey(board.orgSlug, parent.keySeq) ?? parent.title,
    onSelect: () => board.onOpen(parent),
  };
}
