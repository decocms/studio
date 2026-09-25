/**
 * Task board view state (filters + layout) lives in the URL search params, so a
 * refresh, a back/forward, or a shared link keeps the board as you left it.
 *
 * ponytail: TanStack Router's search params already are the store — no zustand,
 * no persist middleware, no localStorage to reconcile with the URL.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import type { DueFilter, TaskFilters } from "./task-filters-core";
import { PRIORITIES, type TaskBoardItemPriority } from "./config";

export type Layout = "board" | "list" | "feed";

const DUE_FILTERS: DueFilter[] = ["overdue", "today", "week", "none"];

/** Search-param names, kept short since they show up in shared links. */
type BoardSearch = {
  view?: string;
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

/** Anything unrecognized in the URL is dropped, not trusted. */
export function parseBoardSearch(
  search: BoardSearch,
  defaultLayout: Layout = "board",
): {
  filters: TaskFilters;
  layout: Layout;
} {
  const priority = str(search.priority);
  const due = str(search.due);
  const tags = str(search.tags);
  return {
    layout:
      search.view === "list" ||
      search.view === "feed" ||
      search.view === "board"
        ? search.view
        : defaultLayout,
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
  filters: TaskFilters,
  layout: Layout,
  defaultLayout: Layout = "board",
): Record<keyof BoardSearch, string | undefined> {
  return {
    view: layout === defaultLayout ? undefined : layout,
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

/** `useState`-shaped replacement for the board's filters + layout state.
 *  `defaultLayout` is the landing view when the URL names none — Board
 *  everywhere, except the project overview's inline tabs, where the board's
 *  own horizontal columns are the wrong shape for a strip under a header;
 *  Feed reads top-to-bottom like the rest of that page. */
export function useBoardSearch(defaultLayout: Layout = "board") {
  const search = useSearch({ strict: false }) as BoardSearch;
  const navigate = useNavigate();
  const { filters, layout } = parseBoardSearch(search, defaultLayout);

  const write = (nextFilters: TaskFilters, nextLayout: Layout) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...boardSearchParams(nextFilters, nextLayout, defaultLayout),
      }),
      // Typing in the search box would otherwise push a history entry per key.
      replace: true,
    });

  return {
    filters,
    layout,
    setFilters: (next: TaskFilters) => write(next, layout),
    setLayout: (next: Layout) => write(filters, next),
  };
}
