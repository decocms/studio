import {
  AlertCircle,
  CheckCircle,
  Circle,
  Eye,
  Loading02,
  Package,
  Rocket01,
  SearchMd,
} from "@untitledui/icons";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import type { TranslationKey, TFunction } from "@/i18n/use-t.ts";
import type { TaskBoardColumnConfig } from "@decocms/shared/organization/schema";
import {
  columnForItem,
  resolveBoardColumns,
} from "@decocms/shared/task-board-columns";
import { useTaskBoardSettings } from "@/hooks/use-organization-settings";

export { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
export { columnForItem };
export type BoardColumn = TaskBoardColumnConfig;

export type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];
export type TaskBoardItemStatus = TaskBoardItem["status"];
export type TaskBoardItemPriority = TaskBoardItem["priority"];
export type TaskBoardItemThread = TaskBoardItem["threads"][number];
export type TaskBoardItemPr =
  ToolOutput<"TASK_BOARD_ITEM_PRS_GET">["prs"][number];

/**
 * A task is "blocked" when one of its agent threads is waiting on human input
 * (`requires_action` — the agent called `user_ask` or needs an approval).
 */
export function isTaskBlocked(item: TaskBoardItem): boolean {
  return item.threads.some((t) => t.status === "requires_action");
}

/** The thread to surface in the card — the most recent linked run. */
export function primaryThread(
  item: TaskBoardItem,
): TaskBoardItemThread | undefined {
  return item.threads[0];
}

/**
 * `sortOrder` a dragged card should take to land right before `beforeId`
 * within `laneItems` (or at the end when `beforeId` is null) — the midpoint
 * of its new neighbors, so reordering never needs to touch other rows.
 */
export function insertSortOrder(
  laneItems: TaskBoardItem[],
  beforeId: string | null,
  draggedId: string,
): number {
  const draggedIndex = laneItems.findIndex((i) => i.id === draggedId);
  // Hovering the dragged card's own row reports itself as `beforeId` — treat
  // that as its current successor (a no-op), not "not found", which the
  // lookup below over `filtered` would otherwise read as "insert at the end".
  const resolvedBeforeId =
    beforeId === draggedId
      ? (laneItems[draggedIndex + 1]?.id ?? null)
      : beforeId;
  const filtered = laneItems.filter((i) => i.id !== draggedId);
  const beforeIndex = resolvedBeforeId
    ? filtered.findIndex((i) => i.id === resolvedBeforeId)
    : -1;
  const insertIndex = beforeIndex === -1 ? filtered.length : beforeIndex;
  const prev = filtered[insertIndex - 1];
  const next = filtered[insertIndex];
  if (prev && next) return (prev.sortOrder + next.sortOrder) / 2;
  if (prev) return prev.sortOrder + 1;
  if (next) return next.sortOrder - 1;
  return 0;
}

/** Short key prefix derived from the org slug (e.g. "osklen" → "OS"), the way
 *  trackers show PROJ-123. Stable per org; falls back to "T". */
function taskKeyPrefix(orgSlug: string): string {
  const alnum = orgSlug.replace(/[^a-zA-Z0-9]/g, "");
  return (alnum.slice(0, 2) || "T").toUpperCase();
}

/** The task's short key ("OS-42"), or null when it has no number yet. */
export function formatTaskKey(
  orgSlug: string,
  seq: number | null,
): string | null {
  return typeof seq === "number" ? `${taskKeyPrefix(orgSlug)}-${seq}` : null;
}

/** Deterministic dot color for a label, so the same label reads the same
 *  everywhere (card chips + the labels picker). Raw palette (like the priority
 *  dots) — labels need distinct hues the design tokens don't provide. */
const LABEL_DOT_COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-green-500",
  "bg-teal-500",
  "bg-blue-500",
  "bg-indigo-500",
  "bg-purple-500",
  "bg-pink-500",
  "bg-slate-500",
];
export function labelDotColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  return LABEL_DOT_COLORS[hash % LABEL_DOT_COLORS.length]!;
}

/**
 * Sprints are calendar weeks the system defines — you pick one, you never
 * create them. A sprint id is the ISO date (YYYY-MM-DD) of that week's Monday,
 * so a task's `sprintId` is just a week key.
 */
export type SprintWeekState = "current" | "upcoming" | "previous";

const SPRINT_DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** Local midnight Monday of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Mon = 0
  return x;
}

function toWeekKey(monday: Date): string {
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const day = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${m}-${day}`;
}

/** "Jul 21 – Jul 27" for a week key; falls back to the raw key if unparseable. */
export function formatSprintRange(weekKey: string): string {
  const start = new Date(`${weekKey}T00:00:00`);
  if (Number.isNaN(start.getTime())) return weekKey;
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${SPRINT_DATE_FMT.format(start)} – ${SPRINT_DATE_FMT.format(end)}`;
}

/** Where a week sits relative to today. */
export function sprintWeekState(weekKey: string): SprintWeekState {
  const start = new Date(`${weekKey}T00:00:00`);
  const thisWeek = startOfWeek(new Date());
  if (toWeekKey(thisWeek) === weekKey) return "current";
  return start.getTime() > thisWeek.getTime() ? "upcoming" : "previous";
}

export function sprintStateLabelKey(state: SprintWeekState): TranslationKey {
  return state === "current"
    ? "taskBoard.taskDialog.sprintStateCurrent"
    : state === "upcoming"
      ? "taskBoard.taskDialog.sprintStateUpcoming"
      : "taskBoard.taskDialog.sprintStatePrevious";
}

export function sprintStateTone(state: SprintWeekState): string {
  return state === "current" ? "text-primary" : "text-muted-foreground";
}

/**
 * The selectable weeks (sprints): current first, then the next 8 upcoming, then
 * the last 4 previous — the system-defined window a task can be filed under.
 */
export function generateSprintWeeks(): string[] {
  const monday = startOfWeek(new Date());
  const key = (offsetWeeks: number) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + offsetWeeks * 7);
    return toWeekKey(d);
  };
  const weeks: string[] = [];
  for (let i = 0; i <= 8; i++) weeks.push(key(i)); // current + upcoming
  for (let i = -1; i >= -4; i--) weeks.push(key(i)); // previous (recent first)
  return weeks;
}

/** Shape of an org member as returned by `useMembers()`, trimmed to the fields used here. */
export type Member = {
  userId: string;
  user?: { name?: string | null; image?: string | null };
};

export const STATUS_CONFIG: Record<
  TaskBoardItemStatus,
  { labelKey: TranslationKey; icon: typeof Circle; iconClassName: string }
> = {
  triage: {
    labelKey: "taskBoard.config.statusBacklog",
    icon: AlertCircle,
    iconClassName: "text-muted-foreground",
  },
  todo: {
    labelKey: "taskBoard.config.statusTodo",
    icon: Circle,
    iconClassName: "text-muted-foreground",
  },
  in_progress: {
    labelKey: "taskBoard.config.statusInProgress",
    icon: Loading02,
    iconClassName: "text-primary",
  },
  in_review: {
    labelKey: "taskBoard.config.statusInReview",
    icon: Eye,
    iconClassName: "text-warning",
  },
  qa: {
    labelKey: "taskBoard.config.statusQa",
    icon: SearchMd,
    iconClassName: "text-warning",
  },
  ready_for_release: {
    labelKey: "taskBoard.config.statusReadyForRelease",
    icon: Package,
    iconClassName: "text-primary",
  },
  deploy: {
    labelKey: "taskBoard.config.statusDeploy",
    icon: Rocket01,
    iconClassName: "text-primary",
  },
  done: {
    labelKey: "taskBoard.config.statusDone",
    icon: CheckCircle,
    iconClassName: "text-success",
  },
};

/** The org's effective board columns (defaults when unconfigured). */
export function useBoardColumns(): BoardColumn[] {
  const settings = useTaskBoardSettings();
  return resolveBoardColumns(settings?.columns);
}

/** A column's display label — its custom name, or its stage's i18n label. */
export function columnLabel(column: BoardColumn, t: TFunction): string {
  return column.name ?? t(STATUS_CONFIG[column.stage].labelKey);
}

/**
 * The update payload that moves a task into `column`. Default columns (id ==
 * stage) keep columnId null so the default board stores no placement data.
 */
export function movePayload(column: BoardColumn): {
  status: TaskBoardItemStatus;
  columnId: string | null;
} {
  return {
    status: column.stage,
    columnId: column.id === column.stage ? null : column.id,
  };
}

export const PRIORITIES: TaskBoardItemPriority[] = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
];

export const PRIORITY_CONFIG: Record<
  TaskBoardItemPriority,
  {
    labelKey: TranslationKey;
    flagClassName: string;
    dotClassName: string;
  }
> = {
  none: {
    labelKey: "taskBoard.config.priorityNone",
    flagClassName: "text-muted-foreground",
    dotClassName: "border border-muted-foreground/50",
  },
  low: {
    labelKey: "taskBoard.config.priorityLow",
    flagClassName: "text-muted-foreground",
    dotClassName: "bg-muted-foreground/40",
  },
  medium: {
    labelKey: "taskBoard.config.priorityMedium",
    flagClassName: "text-blue-500",
    dotClassName: "bg-blue-500",
  },
  high: {
    labelKey: "taskBoard.config.priorityHigh",
    flagClassName: "text-warning",
    dotClassName: "bg-warning",
  },
  urgent: {
    labelKey: "taskBoard.config.priorityUrgent",
    flagClassName: "text-destructive",
    dotClassName: "bg-destructive",
  },
};
