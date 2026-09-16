/**
 * The board's filtering RULES — everything about which cards a `TaskFilters`
 * lets through, and nothing about how the filters are picked.
 *
 * Split out of `task-filters.tsx` because that file is a component module: it
 * pulls Radix and the whole UI tree in with it, and the pure tests (and pure
 * app code such as `task-route.ts`) that only wanted `taskMatchesFilters` were
 * dragging all of it into environments with no DOM. `task-filters.tsx`
 * re-exports this module, so existing imports keep working.
 */

import { parseTaskKeySeq } from "@decocms/shared/task-key";
import type { TranslationKey } from "@/i18n/use-t.ts";
import {
  taskMatchesProjectFilter,
  type ProjectIndex,
} from "@/lib/project-index";
import {
  SUPER_AGENT_ASSIGNEE_ID,
  type TaskBoardItem,
  type TaskBoardItemPriority,
} from "./config";

/** Sentinel assignee filter matching tasks with no assignee. */
export const UNASSIGNED_FILTER = "__unassigned__";

export type DueFilter = "overdue" | "today" | "week" | "none";

export type TaskFilters = {
  /** userId | SUPER_AGENT_ASSIGNEE_ID | UNASSIGNED_FILTER | null (anyone) */
  assignee: string | null;
  priority: TaskBoardItemPriority | null;
  due: DueFilter | null;
  /** Org tag ids — a task matches if it has at least one of these. */
  tags: string[];
  /** A project index bucket id — `owner/name`, a `vir_…` project with no
   *  repository, {@link NO_PROJECT_FILTER}, or null for every project. */
  project: string | null;
  /** Free-text match against title/description, empty string = no filter. */
  search: string;
};

export const EMPTY_FILTERS: TaskFilters = {
  assignee: null,
  priority: null,
  due: null,
  tags: [],
  project: null,
  search: "",
};

const DAY_MS = 86_400_000;

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/**
 * True when the term names this card by the key it SHOWS (see `taskKey`): the
 * full `DECO-01`, a lower-cased or unpadded variant, or a bare number —
 * `parseTaskKeySeq` reads the sequence out of any of them.
 */
export function matchesTaskKey(
  search: string,
  keySeq: number | null | undefined,
): boolean {
  const term = search.trim();
  if (term === "") return false;
  return keySeq != null && parseTaskKeySeq(term) === keySeq;
}

/**
 * Whether a card belongs to `userId`, delegation included.
 *
 * Handing a card to the Super Agent does not hand it away: the board renders
 * the delegator's avatar beside the capybara, so a card that reads as "mine and
 * the Super Agent's" has to survive filtering by me. Delegation counts only on
 * Super Agent cards — `assignedBy` is stamped on every assignee change, so a
 * card one teammate assigned to another is the assignee's, not the assigner's.
 */
function assignedTo(item: TaskBoardItem, userId: string): boolean {
  if (item.assigneeId === userId) return true;
  return (
    item.assigneeId === SUPER_AGENT_ASSIGNEE_ID && item.assignedBy === userId
  );
}

/** `index` is required rather than defaulted: an empty index answers the
 *  no-project bucket with "every card", and a caller that forgot it would
 *  quietly turn one filter into no filter. */
export function taskMatchesFilters(
  item: TaskBoardItem,
  f: TaskFilters,
  index: ProjectIndex,
): boolean {
  const search = f.search.trim().toLowerCase();
  if (search !== "") {
    const haystack = `${item.title} ${item.description ?? ""}`.toLowerCase();
    if (!haystack.includes(search) && !matchesTaskKey(search, item.keySeq)) {
      return false;
    }
  }
  if (f.assignee !== null) {
    if (f.assignee === UNASSIGNED_FILTER) {
      if (item.assigneeId !== null) return false;
    } else if (!assignedTo(item, f.assignee)) {
      return false;
    }
  }
  if (f.priority !== null && item.priority !== f.priority) return false;
  if (f.due !== null) {
    if (f.due === "none") {
      if (item.dueDate) return false;
    } else {
      if (!item.dueDate) return false;
      const t = new Date(item.dueDate).getTime();
      const now = Date.now();
      if (f.due === "overdue" && t >= now) return false;
      if (f.due === "today" && !isSameDay(t, now)) return false;
      if (f.due === "week" && (t < now || t > now + 7 * DAY_MS)) return false;
    }
  }
  if (f.tags.length > 0) {
    const itemTagIds = item.tags.map((tag) => tag.id);
    if (!f.tags.some((id) => itemTagIds.includes(id))) return false;
  }
  if (!taskMatchesProjectFilter(item, f.project, index)) return false;
  return true;
}

export const DUE_OPTIONS_LABEL_KEYS: Record<DueFilter, TranslationKey> = {
  overdue: "taskBoard.taskFilters.dueDateFilterOverdue",
  today: "taskBoard.taskFilters.dueDateFilterDueToday",
  week: "taskBoard.taskFilters.dueDateFilterDueThisWeek",
  none: "taskBoard.taskFilters.dueDateFilterNoDueDate",
};

/** The due windows the filter menu offers, in the order it lists them. */
export const DUE_FILTERS = Object.keys(
  DUE_OPTIONS_LABEL_KEYS,
) as readonly DueFilter[];

export function dueFilterLabelKey(due: DueFilter): TranslationKey {
  return DUE_OPTIONS_LABEL_KEYS[due];
}
