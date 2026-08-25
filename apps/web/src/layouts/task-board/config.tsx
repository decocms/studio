import {
  AlertCircle,
  AlertOctagon,
  Archive,
  ArrowNarrowDown,
  ArrowNarrowUp,
  Beaker01,
  CheckCircle,
  Circle,
  Equal,
  Eye,
  Loading02,
  PlusCircle,
  Shield01,
  Tool01,
  Virus,
} from "@untitledui/icons";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import { DEFAULT_TAG_COLOR } from "@decocms/shared/task-board";
import { isResolvedRunFailure } from "@decocms/shared/entities";
import { sprintRange, type SprintConfig } from "@decocms/shared/sprints";
import type { TranslationKey } from "@/i18n/use-t.ts";

export {
  SUPER_AGENT_ASSIGNEE_ID,
  nextTagColor,
} from "@decocms/shared/task-board";

export type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];
export type TaskBoardItemStatus = TaskBoardItem["status"];
export type TaskBoardItemPriority = TaskBoardItem["priority"];
export type TaskBoardItemType = NonNullable<TaskBoardItem["type"]>;
export type TaskBoardItemThread = TaskBoardItem["threads"][number];
export type TaskBoardItemTag = TaskBoardItem["tags"][number];
export type TaskBoardItemPr =
  ToolOutput<"TASK_BOARD_ITEM_PRS_GET">["prs"][number];

/** Org tag, as returned by TAGS_LIST/TAGS_CREATE (same shape a task's `tags`
 *  snapshot is drawn from). */
export type OrgTag = ToolOutput<"TAGS_LIST">["tags"][number];

/** UTC, matching how `sprintRange` counts days — a local-zone read of the same
 *  boundary shows the day before for anyone west of UTC. */
const SPRINT_DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * The sprint a card should show, or null when the board isn't running sprints.
 *
 * One gate for both the pill and the row that holds it: asking the question
 * twice is what left a card that kept a sprint from before the toggle went off
 * reserving an empty pill slot.
 */
export function visibleSprint(
  sprint: number | null,
  sprintsEnabled: boolean,
): number | null {
  return sprintsEnabled ? sprint : null;
}

/** A sprint's span as `Jan 5 – Jan 18`, or null when the cadence is unusable. */
export function formatSprintDates(
  config: SprintConfig,
  sprint: number,
): string | null {
  const range = sprintRange(config, sprint);
  if (!range) return null;
  const day = (value: string) =>
    SPRINT_DATE_FMT.format(new Date(`${value}T00:00:00.000Z`));
  return `${day(range.start)} – ${day(range.end)}`;
}

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
 * Whether a card is stopped waiting on a person — the one state that colours
 * the whole card.
 *
 * This is `isTaskBlocked` alone, deliberately. `isTaskHandedToHuman` used to
 * colour a card too, but it is only `in_review && !assigneeId`, which cannot
 * tell a deliberate hand-off from a card nobody ever assigned — so every
 * unowned card in the In Review lane came out coloured, which says nothing the
 * lane header doesn't. An unowned card is already legible without a colour:
 * the footer gives every card an assignee slot, and an empty one is the signal.
 *
 * Reserving the colour for `requires_action` keeps it meaning exactly one
 * thing: an agent asked a question and is waiting for the answer.
 */
export function cardNeedsAttention(item: TaskBoardItem): boolean {
  return isTaskBlocked(item);
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

/**
 * Whether any agent on this task is working, or died trying — the whole of what
 * a card says about run state, as a single dot.
 *
 * `"running"` wins over `"failed"` so a visibly working card never reads broken.
 * A failure that is settled history (`isResolvedRunFailure`) returns null, else
 * re-running a card would leave it permanently red.
 */
export function agentPulse(item: TaskBoardItem): "running" | "failed" | null {
  if (item.threads.some((t) => t.status === "in_progress")) return "running";
  const failed = item.threads.some(
    (t) => t.status === "failed" && !isResolvedRunFailure(t.failureKind),
  );
  return failed ? "failed" : null;
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

export const TASK_TYPES: TaskBoardItemType[] = [
  "bug",
  "feature",
  "chore",
  "spike",
  "security",
];

/**
 * A card's kind, as one glyph in the footer.
 *
 * Shape carries the meaning, not colour — five distinct silhouettes (organism,
 * plus, wrench, flask, shield) stay apart at 14px where five hues would not,
 * and the footer already spends its colour budget on priority, checks and the
 * due date. The name is in the tooltip.
 */
export const TASK_TYPE_CONFIG: Record<
  TaskBoardItemType,
  { labelKey: TranslationKey; icon: typeof Circle }
> = {
  bug: { labelKey: "taskBoard.config.typeBug", icon: Virus },
  feature: { labelKey: "taskBoard.config.typeFeature", icon: PlusCircle },
  chore: { labelKey: "taskBoard.config.typeChore", icon: Tool01 },
  spike: { labelKey: "taskBoard.config.typeSpike", icon: Beaker01 },
  security: { labelKey: "taskBoard.config.typeSecurity", icon: Shield01 },
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
    /** The card footer's single priority glyph — direction reads as rank the
     *  way Jira's does, so it needs no legend. */
    icon: typeof Circle;
    iconClassName: string;
  }
> = {
  none: {
    labelKey: "taskBoard.config.priorityNone",
    flagClassName: "text-muted-foreground",
    dotClassName: "border border-muted-foreground/50",
    icon: Equal,
    iconClassName: "text-muted-foreground/40",
  },
  low: {
    labelKey: "taskBoard.config.priorityLow",
    flagClassName: "text-muted-foreground",
    dotClassName: "bg-muted-foreground/40",
    icon: ArrowNarrowDown,
    iconClassName: "text-muted-foreground",
  },
  medium: {
    labelKey: "taskBoard.config.priorityMedium",
    flagClassName: "text-blue-500",
    dotClassName: "bg-blue-500",
    icon: Equal,
    iconClassName: "text-blue-500",
  },
  high: {
    labelKey: "taskBoard.config.priorityHigh",
    flagClassName: "text-warning",
    dotClassName: "bg-warning",
    icon: ArrowNarrowUp,
    iconClassName: "text-warning",
  },
  urgent: {
    labelKey: "taskBoard.config.priorityUrgent",
    flagClassName: "text-destructive",
    dotClassName: "bg-destructive",
    icon: AlertOctagon,
    iconClassName: "text-destructive",
  },
};

/**
 * How soon a due date is, or null when it is far enough out that a card should
 * not spend a line on it.
 *
 * A board card is a glance, and a date three weeks away answers a question
 * nobody is asking while it is on screen; the list view and the dialog still
 * show every date. `soon` deliberately includes today.
 */
export function dueDateUrgency(
  iso: string,
  now: number = Date.now(),
): "overdue" | "soon" | null {
  const due = new Date(iso).getTime();
  if (Number.isNaN(due)) return null;
  if (due < now) return "overdue";
  return due - now <= DUE_SOON_DAYS * 86_400_000 ? "soon" : null;
}

/** How far ahead a due date still counts as worth a card's ink. */
const DUE_SOON_DAYS = 3;

/** A tag's dot color — arbitrary hex off `organization_tags.color`, hence an
 *  inline style rather than a Tailwind token. */
export function tagDotColor(color: string | null | undefined): string {
  return color ?? DEFAULT_TAG_COLOR;
}
