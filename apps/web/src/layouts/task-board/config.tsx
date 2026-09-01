import type { CanonicalColumnKey } from "@decocms/shared/task-board";
import {
  AlertCircle,
  AlertOctagon,
  Archive,
  ArrowNarrowDown,
  ArrowNarrowUp,
  CheckCircle,
  Circle,
  Equal,
  Eye,
  Lightbulb02,
  Loading02,
  PlusCircle,
  Rocket01,
  Settings01,
  Shield01,
  ShieldTick,
  ThumbsUp,
} from "@untitledui/icons";
import { Bug } from "lucide-react";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import { DEFAULT_TAG_COLOR, DELIVERY_LANES } from "@decocms/shared/task-board";
import { isResolvedRunFailure } from "@decocms/shared/entities";
import type { Sprint } from "@decocms/shared/sprints";
import type { ComponentType } from "react";
import type { TranslationKey } from "@/i18n/use-t.ts";

export {
  DEFAULT_TASK_TYPE,
  SUPER_AGENT_ASSIGNEE_ID,
  nextTagColor,
} from "@decocms/shared/task-board";

export type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];
/**
 * A board column as the SERVER sends it.
 *
 * The wire type, not shared's `BoardColumn`: that one also carries the tracker
 * statuses a column groups, which exist for the Jira push and are nobody's
 * business in a browser. Deriving from the contract is what keeps the two from
 * drifting apart silently.
 */
export type BoardColumn = ToolOutput<"TASK_BOARD_ITEM_LIST">["columns"][number];
export type { Sprint };
export type TaskBoardItemStatus = TaskBoardItem["status"];
export type TaskBoardItemPriority = TaskBoardItem["priority"];
export type TaskBoardItemType = NonNullable<TaskBoardItem["type"]>;
export type TaskBoardItemThread = TaskBoardItem["threads"][number];
export type TaskBoardItemTag = TaskBoardItem["tags"][number];
export type TaskBoardItemPr =
  ToolOutput<"TASK_BOARD_ITEM_PRS_GET">["prs"][number];

/**
 * An infrastructure retry is not news. Each one wrote its own
 * `In Progress → In Progress` activity ("scheduled retry 1 of 1 — error"), so a
 * card that burned its budget read as a wall of retry chatter with the actual
 * story buried in it. The retry is still counted — the terminal
 * `activityRetriesExhausted` line ("moved to To Do after N failed retries") is
 * the part a person acts on, and it survives this filter.
 */
export function isFeedWorthyActivity(a: {
  action: string;
  data?: Record<string, unknown> | null;
}): boolean {
  return !(a.action === "status_changed" && typeof a.data?.retry === "number");
}

/**
 * The same noise from the other side: every retry spawns a fresh thread, and
 * each one rendered its own card, so three attempts meant three near-identical
 * "Retried" cards stacked above the one that matters.
 *
 * `superseded` means a NEWER attempt replaced this one, so a superseded thread
 * can never be the newest — the live (or last) run always survives this filter,
 * and with it the link to a transcript.
 */
export function isLiveAttempt(thread: {
  failureKind?: string | null;
}): boolean {
  return thread.failureKind !== "superseded";
}

/** Org tag, as returned by TAGS_LIST/TAGS_CREATE (same shape a task's `tags`
 *  snapshot is drawn from). */
export type OrgTag = ToolOutput<"TAGS_LIST">["tags"][number];

/** UTC: a sprint's dates are calendar days in Jira, so rendering them in the
 *  viewer's zone shows the day before for anyone west of UTC. */
const SPRINT_DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** A sprint's span as `Jan 5 – Jan 18`, or null when it carries no dates (a
 *  planned sprint nobody has scheduled yet). */
export function formatSprintDates(sprint: Sprint): string | null {
  const day = (value: string | null) => {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : SPRINT_DATE_FMT.format(new Date(ms));
  };
  const start = day(sprint.startsAt);
  const end = day(sprint.endsAt);
  if (!start && !end) return null;
  return start && end ? `${start} – ${end}` : (start ?? end);
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
    : laneVisual(item.status).iconClassName;
}

/**
 * Whether any agent on this task is working, or died trying — the whole of what
 * a card says about run state, as a single glyph.
 *
 * `"running"` wins over `"failed"` so a visibly working card never reads broken.
 * A failure that is settled history (`isResolvedRunFailure`) returns null, else
 * re-running a card would leave it permanently red.
 */
export function agentRunState(
  item: TaskBoardItem,
): "running" | "failed" | null {
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

/**
 * Lanes that don't earn a board column by default — they sit collapsed under
 * "Hidden columns" until shown. They stay a column of the board, so "Move to",
 * drag targets and status validation still know about them.
 */
export const HIDDEN_STATUSES: string[] = ["archived"];

/** Keyed by Studio's OWN lanes, not by a card's status. Exhaustive on purpose:
 *  adding a lane is a compile error here. A card's status is any column key,
 *  which is what `laneVisual` and `laneLabel` are for. */
export const STATUS_CONFIG: Record<
  CanonicalColumnKey,
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
  approved: {
    labelKey: "taskBoard.config.statusApproved",
    icon: ThumbsUp,
    iconClassName: "text-success",
  },
  merged: {
    labelKey: "taskBoard.config.statusMerged",
    icon: Rocket01,
    iconClassName: "text-primary",
  },
  post_deploy_validation: {
    labelKey: "taskBoard.config.statusPostDeployValidation",
    icon: ShieldTick,
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

/** What a lane looks like, for a status we may not recognise. */
export type LaneVisual = {
  icon: typeof Circle;
  iconClassName: string;
};

/** Neutral stand-in for a column Studio did not name. An org board's columns
 *  come from its tracker, so there is no icon of ours and no translation. */
const UNKNOWN_LANE: LaneVisual = {
  icon: Circle,
  iconClassName: "text-muted-foreground",
};

/** Widened on purpose. `STATUS_CONFIG` is exhaustive over Studio's own lanes —
 *  that is what makes adding one a compile error — but a card's status is any
 *  column key, and indexing the closed Record would let the compiler believe
 *  every lookup hits. */
const LANE_VISUALS: Record<string, LaneVisual> = STATUS_CONFIG;

export function laneVisual(status: string): LaneVisual {
  return LANE_VISUALS[status] ?? UNKNOWN_LANE;
}

/**
 * What to call a lane.
 *
 * Studio's own lanes are translated; a column mirrored from a tracker is
 * called whatever that tracker calls it, which is not ours to translate.
 *
 * Module-private on purpose: naming a lane requires knowing whether the board
 * even HAS a column for it, and every caller that skipped that question got a
 * canonical translation for a status the board could not place. Go through
 * {@link laneHeader}.
 */
function laneLabel(
  status: string,
  t: (key: TranslationKey) => string,
  title: string,
): string {
  const known = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG];
  return known ? t(known.labelKey) : title;
}

/**
 * How a lane reads on THIS board.
 *
 * A column the board owns is drawn with its own name and, when it is one of
 * Studio's, our icon. A status no column accounts for gets neither: it is
 * named by its raw key and drawn with the neutral visual, because borrowing
 * ours is exactly what let an unplaceable card pass for a column somebody
 * configured. A `triage` card stranded on a Jira board rendered as "Backlog" —
 * a second one, next to the tracker's real Backlog, that nobody could act on
 * because it does not exist over there.
 */
export function laneHeader(
  status: string,
  t: (key: TranslationKey) => string,
  columns: readonly BoardColumn[],
): { label: string; visual: LaneVisual; offBoard: boolean } {
  const column = columns.find((c) => c.key === status);
  if (!column) {
    return { label: status, visual: UNKNOWN_LANE, offBoard: true };
  }
  return {
    label: laneLabel(status, t, column.title),
    visual: laneVisual(status),
    offBoard: false,
  };
}

export const TASK_TYPES: TaskBoardItemType[] = [
  "bug",
  "feature",
  "chore",
  "spike",
  "security",
];

/** The props both icon sets on this board agree on. */
type TaskTypeIconComponent = ComponentType<{
  size?: number;
  className?: string;
  "aria-label"?: string;
}>;

/** A card's kind, as one glyph in the footer. The name is in the tooltip. */
export const TASK_TYPE_CONFIG: Record<
  TaskBoardItemType,
  {
    labelKey: TranslationKey;
    icon: TaskTypeIconComponent;
    iconClassName: string;
  }
> = {
  bug: {
    labelKey: "taskBoard.config.typeBug",
    icon: Bug,
    iconClassName: "text-destructive",
  },
  feature: {
    labelKey: "taskBoard.config.typeFeature",
    icon: PlusCircle,
    iconClassName: "text-success",
  },
  // Grey on purpose: `chore` is the DEFAULT type, so it lands on every card
  // nobody classified. A colour there would be on most of the board, saying
  // nothing — the one type worth NOT painting is the one you get for free.
  chore: {
    labelKey: "taskBoard.config.typeChore",
    icon: Settings01,
    iconClassName: "text-muted-foreground",
  },
  spike: {
    labelKey: "taskBoard.config.typeSpike",
    icon: Lightbulb02,
    iconClassName: "text-yellow-500",
  },
  // Purple, vacated by spike: security can't take amber without reading as the
  // High priority arrow two glyphs to its right, and red is the bug's.
  security: {
    labelKey: "taskBoard.config.typeSecurity",
    icon: Shield01,
    iconClassName: "text-purple-500",
  },
};

/** True for one of the post-merge delivery lanes. */
export function isDeliveryLane(status: string): boolean {
  return (DELIVERY_LANES as string[]).includes(status);
}

/**
 * Lanes a card may be MOVED to — "Move to", the status dropdown.
 *
 * The board's own columns, not Studio's: on a board mirrored from a tracker
 * every canonical lane is a column that does not exist, and the server rejects
 * the write, so the menu was offering a list of ways to fail. With the delivery
 * lanes off they aren't offered either, so nobody can put a card somewhere the
 * org's state machine doesn't ship to.
 */
export function moveTargets(
  columns: readonly BoardColumn[],
  deliveryEnabled: boolean,
): string[] {
  return columns
    .map((column) => column.key)
    .filter((key) => deliveryEnabled || !isDeliveryLane(key));
}

/**
 * Which lanes the board draws as columns, and which collapse into the "Hidden
 * columns" drawer. A lane hides when it's hidden by default (`HIDDEN_STATUSES`)
 * or is a delivery lane the board doesn't run; `shownLanes` overrides either.
 * `occupied` is what keeps a card from getting stuck: an unrun delivery lane is
 * absent while empty, but reappears in the drawer the moment a card sits in it.
 */
export function laneVisibility({
  columns,
  deliveryEnabled,
  shownLanes,
  occupied,
}: {
  /** The board's own columns, left to right, as the server sent them. Empty
   *  only while the read is in flight — an org that owns its board and has no
   *  columns yet genuinely has an empty board, and rendering Studio's lanes
   *  instead would file its cards under lanes nobody chose. */
  columns: readonly { key: string }[];
  deliveryEnabled: boolean;
  /** `string[]`: it comes out of localStorage, which can hold a dead lane. */
  shownLanes: readonly string[];
  occupied: readonly string[];
}): {
  lanes: string[];
  hidden: string[];
  hideable: string[];
  /** Lanes that exist only because cards are stuck in them — see below. Kept
   *  separate so the board can draw them as what they are, and refuse drops
   *  into a lane that is not a column. */
  unplaced: string[];
} {
  const known = columns
    .map((column) => column.key)
    .filter(
      (s) => deliveryEnabled || !isDeliveryLane(s) || occupied.includes(s),
    );
  const hideable = known.filter(
    (s) =>
      HIDDEN_STATUSES.includes(s) || (!deliveryEnabled && isDeliveryLane(s)),
  );
  const hidden = hideable.filter((s) => !shownLanes.includes(s));

  // A status no column accounts for, but cards are sitting in. Appended as its
  // own lane rather than hidden or re-filed: a card the board cannot place is
  // still the org's card, and rendering it under a column we picked would be
  // us deciding something only they can. Deliberately not hideable — hiding it
  // is the invisibility this exists to prevent. It goes away when the last card
  // leaves, the same way a column the tracker dropped does.
  const placed = new Set(known);
  const unplaced = [...new Set(occupied)].filter((s) => !placed.has(s)).sort();

  return {
    lanes: [...known.filter((s) => !hidden.includes(s)), ...unplaced],
    hidden,
    hideable,
    unplaced,
  };
}

/** dnd-kit id prefix for a lane's own droppable — the empty space below the
 *  last card. Anything else `over` reports is a card id. */
export const LANE_DROPPABLE_PREFIX = "lane:";

/**
 * Where a drag currently sits, or null when it sits nowhere it may land.
 *
 * Two ways to be over a lane — its own droppable, or a card in it — and one
 * rule over both: the landing has to be a column this board HAS.
 *
 * Both halves of that were wrong. The droppable was matched against Studio's
 * canonical statuses, which on a board mirrored from a tracker match no column
 * at all, so dragging into an empty column resolved to null and the card
 * sprang back. And a card in an off-board lane resolved to that lane, which is
 * not a column either — the server rejects the write, so the drop only looked
 * like it worked until the list refetched.
 */
export function dropLane({
  overId,
  columnKeys,
  statusOf,
}: {
  overId: string | number | undefined;
  /** Keys of the board's own columns. */
  columnKeys: ReadonlySet<string>;
  /** A card's lane, by card id. */
  statusOf: (cardId: string) => string | undefined;
}): string | null {
  if (overId === undefined) return null;
  const id = String(overId);
  const status = id.startsWith(LANE_DROPPABLE_PREFIX)
    ? id.slice(LANE_DROPPABLE_PREFIX.length)
    : statusOf(id);
  return status !== undefined && columnKeys.has(status) ? status : null;
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

/** A tag's colour: arbitrary hex off `organization_tags.color`, damped by the theme's `--user-color-strength` so a vivid hex doesn't shout on a dark surface. */
export function tagDotColor(color: string | null | undefined): string {
  const hex = color ?? DEFAULT_TAG_COLOR;
  return `color-mix(in oklab, ${hex} var(--user-color-strength), transparent)`;
}
