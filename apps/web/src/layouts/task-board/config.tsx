import {
  AlertCircle,
  CheckCircle,
  Circle,
  Eye,
  Loading02,
} from "@untitledui/icons";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import type { TranslationKey } from "@/i18n/use-t.ts";

export { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

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

/** Shape of an org member as returned by `useMembers()`, trimmed to the fields used here. */
export type Member = {
  userId: string;
  user?: { name?: string | null; image?: string | null };
};

export const STATUSES: TaskBoardItemStatus[] = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
];

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
  done: {
    labelKey: "taskBoard.config.statusDone",
    icon: CheckCircle,
    iconClassName: "text-success",
  },
};

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
