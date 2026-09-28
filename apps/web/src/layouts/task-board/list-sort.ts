/** Pure ordering for the list view. Sorting runs before grouping, so every
 *  section reads in the chosen order too. */

import { entryForTask, type ProjectIndex } from "@/lib/project-index";
import {
  PRIORITIES,
  SUPER_AGENT_ASSIGNEE_ID,
  type TaskBoardItem,
} from "./config";

export const SORT_BY_OPTIONS = [
  "assignee",
  "due",
  "tags",
  "project",
  "priority",
] as const;

export type SortBy = (typeof SORT_BY_OPTIONS)[number];

export type SortDirection = "asc" | "desc";

export function isSortBy(value: unknown): value is SortBy {
  return (SORT_BY_OPTIONS as readonly unknown[]).includes(value);
}

/** The direction a criterion reads best in: most urgent priority first,
 *  soonest due date first, names A→Z. */
export function defaultSortDirection(sortBy: SortBy): SortDirection {
  return sortBy === "priority" ? "desc" : "asc";
}

export type SortContext = {
  /** Display names by user id, for the assignee order. */
  memberNames: ReadonlyMap<string, string>;
  /** Label for the Super Agent, which sorts by name like anyone else. */
  superAgentName: string;
  index: ProjectIndex;
};

/**
 * `items` in `sortBy` order. Tasks missing the value (no assignee, no due
 * date, no tags, no project, no priority) close the list whatever the
 * direction, and ties keep their incoming order.
 */
export function sortListItems(
  items: readonly TaskBoardItem[],
  sortBy: SortBy,
  direction: SortDirection,
  context: SortContext,
): TaskBoardItem[] {
  const keyOf = sortKey(sortBy, context);
  const sign = direction === "asc" ? 1 : -1;
  return items
    .map((item) => ({ item, key: keyOf(item) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) {
        return a.key === b.key ? 0 : a.key === null ? 1 : -1;
      }
      return sign * compareKeys(a.key, b.key);
    })
    .map(({ item }) => item);
}

function compareKeys(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, {
    sensitivity: "base",
  });
}

function sortKey(
  sortBy: SortBy,
  context: SortContext,
): (item: TaskBoardItem) => string | number | null {
  switch (sortBy) {
    case "assignee":
      return (item) => {
        if (!item.assigneeId) return null;
        if (item.assigneeId === SUPER_AGENT_ASSIGNEE_ID)
          return context.superAgentName;
        return context.memberNames.get(item.assigneeId) ?? item.assigneeId;
      };
    case "due":
      return (item) => (item.dueDate ? Date.parse(item.dueDate) : null);
    case "tags":
      return (item) =>
        item.tags.length > 0
          ? item.tags
              .map((tag) => tag.name)
              .sort((a, b) => a.localeCompare(b))[0]!
          : null;
    case "project":
      return (item) => entryForTask(item, context.index)?.title ?? null;
    case "priority":
      return (item) =>
        item.priority === "none" ? null : PRIORITIES.indexOf(item.priority);
    default: {
      const exhaustive: never = sortBy;
      return exhaustive;
    }
  }
}
