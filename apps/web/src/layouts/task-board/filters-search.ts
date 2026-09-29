/**
 * Task board view state (filters, layout, list grouping and sorting) lives in the URL search params, so a
 * refresh, a back/forward, or a shared link keeps the board as you left it.
 *
 * ponytail: TanStack Router's search params already are the store — no zustand,
 * no persist middleware, no localStorage to reconcile with the URL.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import type { DueFilter, TaskFilters } from "./task-filters-core";
import { PRIORITIES, type TaskBoardItemPriority } from "./config";
import { isGroupBy, type GroupBy } from "./list-groups";
import {
  defaultSortDirection,
  isSortBy,
  type SortBy,
  type SortDirection,
} from "./list-sort";

const LAYOUTS = ["board", "list", "feed"] as const;

export type Layout = (typeof LAYOUTS)[number];

const DUE_FILTERS: DueFilter[] = ["overdue", "today", "week", "none"];

/** Search-param names, kept short since they show up in shared links. */
type BoardSearch = {
  view?: string;
  /** The list view's grouping criterion. */
  group?: string;
  /** A second criterion nested inside each group. */
  subgroup?: string;
  /** The list view's sort criterion. */
  sort?: string;
  /** Written only when it differs from the criterion's default direction. */
  dir?: string;
  q?: string;
  assignee?: string;
  priority?: string;
  due?: string;
  tags?: string;
  /**
   * The project filter. Still keyed `repo` because that key is DECLARED — on
   * `tasksRoute.validateSearch` and on `unifiedChatSearchSchema`, which are
   * bare `z.object`s that strip anything they do not enumerate — and because
   * every `?repo=owner/name` link anyone has shared has to keep working. The
   * VALUE domain widened (a bucket id: `owner/name`, a `vir_…` project, or
   * `__no_repo__`); the key did not.
   */
  repo?: string;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

export type BoardView = {
  filters: TaskFilters;
  layout: Layout;
  groupBy: GroupBy | null;
  subgroupBy: GroupBy | null;
  sortBy: SortBy | null;
  sortDirection: SortDirection;
};

/** Anything unrecognized in the URL is dropped, not trusted. `defaultLayout`
 *  is the landing view when the URL names none — Board everywhere, except the
 *  project overview's inline tabs, where the board's horizontal columns are the
 *  wrong shape for a strip under a header and Feed reads top to bottom. */
export function parseBoardSearch(
  search: BoardSearch,
  defaultLayout: Layout = "board",
): BoardView {
  const priority = str(search.priority);
  const due = str(search.due);
  const tags = str(search.tags);
  const groupBy = isGroupBy(search.group) ? search.group : null;
  const sortBy = isSortBy(search.sort) ? search.sort : null;
  return {
    layout: LAYOUTS.includes(search.view as Layout)
      ? (search.view as Layout)
      : defaultLayout,
    groupBy,
    subgroupBy:
      groupBy !== null &&
      isGroupBy(search.subgroup) &&
      search.subgroup !== groupBy
        ? search.subgroup
        : null,
    sortBy,
    sortDirection:
      search.dir === "asc" || search.dir === "desc"
        ? search.dir
        : sortBy !== null
          ? defaultSortDirection(sortBy)
          : "asc",
    filters: {
      search: str(search.q) ?? "",
      assignee: str(search.assignee),
      priority: PRIORITIES.includes(priority as TaskBoardItemPriority)
        ? (priority as TaskBoardItemPriority)
        : null,
      due: DUE_FILTERS.includes(due as DueFilter) ? (due as DueFilter) : null,
      tags: tags ? tags.split(",").filter(Boolean) : [],
      project: str(search.repo),
    },
  };
}

/** Defaults are written as `undefined` so they drop out of the URL entirely. */
export function boardSearchParams(
  { filters, layout, groupBy, subgroupBy, sortBy, sortDirection }: BoardView,
  defaultLayout: Layout = "board",
): Record<keyof BoardSearch, string | undefined> {
  return {
    view: layout === defaultLayout ? undefined : layout,
    group: groupBy ?? undefined,
    subgroup: groupBy !== null ? (subgroupBy ?? undefined) : undefined,
    sort: sortBy ?? undefined,
    dir:
      sortBy !== null && sortDirection !== defaultSortDirection(sortBy)
        ? sortDirection
        : undefined,
    q: filters.search === "" ? undefined : filters.search,
    assignee: filters.assignee ?? undefined,
    priority: filters.priority ?? undefined,
    due: filters.due ?? undefined,
    tags: filters.tags.length > 0 ? filters.tags.join(",") : undefined,
    repo: filters.project ?? undefined,
  };
}

/**
 * The selection a bulk action is allowed to touch: only cards currently on
 * screen. The project scope is not the board's own control — it can change
 * under a live selection — so a stale id must never reach an update or a
 * delete for a card the user cannot see.
 */
export function visibleSelection(
  selection: ReadonlySet<string>,
  visibleItems: readonly { id: string }[],
): Set<string> {
  const visible = new Set(visibleItems.map((item) => item.id));
  return new Set([...selection].filter((id) => visible.has(id)));
}

/** `useState`-shaped replacement for the board's view state. */
export function useBoardSearch(defaultLayout: Layout = "board") {
  const search = useSearch({ strict: false }) as BoardSearch;
  const navigate = useNavigate();
  const view = parseBoardSearch(search, defaultLayout);
  const { groupBy, subgroupBy } = view;

  const write = (patch: Partial<BoardView>) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...boardSearchParams({ ...view, ...patch }, defaultLayout),
      }),
      // Typing in the search box would otherwise push a history entry per key.
      replace: true,
    });

  return {
    ...view,
    setFilters: (filters: TaskFilters) => write({ filters }),
    setLayout: (layout: Layout) => write({ layout }),
    /** Picking the sub-group's criterion as the group swaps the two. */
    setGroupBy: (next: GroupBy | null) =>
      write({
        groupBy: next,
        subgroupBy: next !== null && next === subgroupBy ? groupBy : subgroupBy,
      }),
    setSubgroupBy: (next: GroupBy | null) => write({ subgroupBy: next }),
    /** A new criterion starts in the direction it reads best in. */
    setSortBy: (next: SortBy | null) =>
      write({
        sortBy: next,
        sortDirection: next !== null ? defaultSortDirection(next) : "asc",
      }),
    setSortDirection: (sortDirection: SortDirection) =>
      write({ sortDirection }),
  };
}
