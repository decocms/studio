import {
  AlertCircle,
  Archive,
  CheckCircle,
  Circle,
  Eye,
  Loading02,
} from "@untitledui/icons";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import {
  DEFAULT_TAG_COLOR,
  isReviewerThreadTitle,
  REVIEWER_KINDS,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import type { TranslationKey } from "@/i18n/use-t.ts";

export {
  SUPER_AGENT_ASSIGNEE_ID,
  isReviewerThreadTitle,
  nextTagColor,
} from "@decocms/shared/task-board";

export type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];
export type TaskBoardItemStatus = TaskBoardItem["status"];
export type TaskBoardItemPriority = TaskBoardItem["priority"];
export type TaskBoardItemThread = TaskBoardItem["threads"][number];
export type TaskBoardItemTag = TaskBoardItem["tags"][number];
export type TaskBoardItemPr =
  ToolOutput<"TASK_BOARD_ITEM_PRS_GET">["prs"][number];

/** Org tag, as returned by TAGS_LIST/TAGS_CREATE (same shape a task's `tags`
 *  snapshot is drawn from). */
export type OrgTag = ToolOutput<"TAGS_LIST">["tags"][number];

/**
 * A task is "blocked" when one of its agent threads is waiting on human input
 * (`requires_action` — the agent called `user_ask` or needs an approval).
 */
export function isTaskBlocked(item: TaskBoardItem): boolean {
  return item.threads.some((t) => t.status === "requires_action");
}

/**
 * A task the automation gave up on: parked In Review with no assignee.
 *
 * Every automatic path except the auto-merge retry requires the Super Agent as
 * assignee, so this card is waiting on a person — but it renders exactly like
 * one still waiting on its reviewers. The hand-off reason is on the timeline
 * (`assignee_changed`); the badge is what makes it findable at all.
 */
export function isTaskHandedToHuman(item: TaskBoardItem): boolean {
  return item.status === "in_review" && !item.assigneeId;
}

/**
 * Status-icon classes for a task card/row. A task waiting on input pulses in
 * `warning` — same token as its "Needs input" badge, so a stalled task doesn't
 * look like it's still progressing.
 */
export function statusIconClassName(item: TaskBoardItem): string {
  return item.status === "in_progress" && isTaskBlocked(item)
    ? "text-warning animate-pulse"
    : STATUS_CONFIG[item.status].iconClassName;
}

/** The thread to surface in the card — the most recent linked run. */
export function primaryThread(
  item: TaskBoardItem,
): TaskBoardItemThread | undefined {
  return item.threads[0];
}

/** The QA/code-review threads linked to this task, in `REVIEWER_KINDS` order —
 *  present only once that reviewer has actually run. */
export function reviewerThreads(
  item: TaskBoardItem,
): { kind: ReviewerKind; thread: TaskBoardItemThread }[] {
  return REVIEWER_KINDS.flatMap((kind) => {
    const thread = item.threads.find((t) =>
      isReviewerThreadTitle(t.title, kind),
    );
    return thread ? [{ kind, thread }] : [];
  });
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

/**
 * `sortOrder` for each card in a run dropped together at `slot`, preserving the
 * input order. Lanes sort ASCENDING, so the run walks backwards from the slot —
 * the last card gets `slot` and earlier ones sit just before it. Getting the
 * direction wrong silently reverses the group, which is why this is a function
 * with a test rather than an expression at the call site.
 */
export function runSortOrders(slot: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => slot - (count - 1 - i) * 1e-4);
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
  "archived",
];

/**
 * Lanes that don't earn a board column by default — they sit collapsed under
 * "Hidden columns" until shown. They stay in `STATUSES`, so "Move to", drag
 * targets and status validation still know about them.
 */
export const HIDDEN_STATUSES: TaskBoardItemStatus[] = ["archived"];

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
  archived: {
    labelKey: "taskBoard.config.statusArchived",
    icon: Archive,
    iconClassName: "text-muted-foreground",
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

/** A tag's dot color — arbitrary hex off `organization_tags.color`, hence an
 *  inline style rather than a Tailwind token. */
export function tagDotColor(color: string | null | undefined): string {
  return color ?? DEFAULT_TAG_COLOR;
}
