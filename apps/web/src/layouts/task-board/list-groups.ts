/** Pure grouping for the list view: which section each task lands in, and the
 *  order the sections read in. Labels are the component's job. */

import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import {
  entryForTask,
  NO_PROJECT_FILTER,
  type ProjectIndex,
} from "@/lib/project-index";
import {
  PRIORITIES,
  SUPER_AGENT_ASSIGNEE_ID,
  type TaskBoardItem,
} from "./config";
import { UNASSIGNED_FILTER } from "./task-filters-core";

export const GROUP_BY_OPTIONS = [
  "status",
  "assignee",
  "priority",
  "tags",
  "project",
] as const;

export type GroupBy = (typeof GROUP_BY_OPTIONS)[number];

export function isGroupBy(value: unknown): value is GroupBy {
  return (GROUP_BY_OPTIONS as readonly unknown[]).includes(value);
}

/** Section key for tasks without any tag. */
export const NO_TAG_GROUP = "__no_tag__";

/** A section of the list; `children` holds its sub-sections when nested. */
export type ListGroup = {
  groupBy: GroupBy;
  key: string;
  /** Unique across the whole tree and stable while the grouping holds — the
   *  collapse state is keyed by it. */
  path: string;
  items: TaskBoardItem[];
  children: ListGroup[] | null;
};

export type GroupContext = {
  /** Org members in display order. */
  memberIds: readonly string[];
  /** Org tags in display order. */
  tagIds: readonly string[];
  index: ProjectIndex;
};

/**
 * The grouping levels a view asks for: none, one, or a group and a different
 * sub-group. Grouping twice by the same criterion would repeat every header.
 */
export function groupLevels(
  groupBy: GroupBy | null,
  subgroupBy: GroupBy | null,
): GroupBy[] {
  if (groupBy === null) return [];
  if (subgroupBy === null || subgroupBy === groupBy) return [groupBy];
  return [groupBy, subgroupBy];
}

/**
 * Buckets `items` level by level, keeping their order inside each section and
 * dropping empty sections. A task with several tags is listed under each of
 * them, since a single section would misstate the others.
 *
 * Keys the context does not know (a status from a newer server, a departed
 * member) follow the known ones in first-seen order; the "none" bucket closes.
 */
export function groupListItems(
  items: readonly TaskBoardItem[],
  levels: readonly GroupBy[],
  context: GroupContext,
  parentPath = "",
): ListGroup[] {
  const [groupBy, ...rest] = levels;
  if (groupBy === undefined) return [];
  const { keysOf, order, last } = strategy(groupBy, context);
  const buckets = new Map<string, TaskBoardItem[]>();
  for (const item of items) {
    for (const key of keysOf(item)) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }
  }

  const seen = [...buckets.keys()];
  const rank = (key: string) => {
    if (key === last) return Number.MAX_SAFE_INTEGER;
    const known = order.indexOf(key);
    return known !== -1 ? known : order.length + seen.indexOf(key);
  };
  return seen
    .sort((a, b) => rank(a) - rank(b))
    .map((key) => {
      const groupItems = buckets.get(key) ?? [];
      const path = `${parentPath}/${groupBy}:${key}`;
      return {
        groupBy,
        key,
        path,
        items: groupItems,
        children:
          rest.length > 0
            ? groupListItems(groupItems, rest, context, path)
            : null,
      };
    });
}

function strategy(
  groupBy: GroupBy,
  context: GroupContext,
): {
  keysOf: (item: TaskBoardItem) => string[];
  order: readonly string[];
  last?: string;
} {
  switch (groupBy) {
    case "status":
      return { keysOf: (item) => [item.status], order: CANONICAL_COLUMN_KEYS };
    case "priority":
      return {
        keysOf: (item) => [item.priority],
        order: [...PRIORITIES].reverse(),
      };
    case "assignee":
      return {
        keysOf: (item) => [item.assigneeId ?? UNASSIGNED_FILTER],
        order: [SUPER_AGENT_ASSIGNEE_ID, ...context.memberIds],
        last: UNASSIGNED_FILTER,
      };
    case "tags":
      return {
        keysOf: (item) =>
          item.tags.length > 0
            ? item.tags.map((tag) => tag.id)
            : [NO_TAG_GROUP],
        order: context.tagIds,
        last: NO_TAG_GROUP,
      };
    case "project":
      return {
        keysOf: (item) => [
          entryForTask(item, context.index)?.id ?? NO_PROJECT_FILTER,
        ],
        order: context.index.entries.map((entry) => entry.id),
        last: NO_PROJECT_FILTER,
      };
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

/**
 * The collapsed set after a click on `path`'s header. With `all` (Alt+click,
 * as in Linear) every sibling follows the clicked group's new state.
 */
export function toggleCollapsed(
  collapsed: ReadonlySet<string>,
  path: string,
  siblingPaths: readonly string[],
  all: boolean,
): Set<string> {
  const next = new Set(collapsed);
  const collapse = !collapsed.has(path);
  for (const target of all ? siblingPaths : [path]) {
    if (collapse) next.add(target);
    else next.delete(target);
  }
  return next;
}
