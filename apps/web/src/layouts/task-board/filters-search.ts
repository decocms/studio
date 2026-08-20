/**
 * Task board view state (filters + layout) lives in the URL search params, so a
 * refresh, a back/forward, or a shared link keeps the board as you left it.
 *
 * ponytail: TanStack Router's search params already are the store — no zustand,
 * no persist middleware, no localStorage to reconcile with the URL.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import type { DueFilter, TaskFilters } from "./task-filters";
import { PRIORITIES, type TaskBoardItemPriority } from "./config";

export type Layout = "board" | "list";

const DUE_FILTERS: DueFilter[] = ["overdue", "today", "week", "none"];

/** Search-param names, kept short since they show up in shared links. */
type BoardSearch = {
  view?: string;
  q?: string;
  assignee?: string;
  priority?: string;
  due?: string;
  tags?: string;
  repo?: string;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

/** Anything unrecognized in the URL is dropped, not trusted. */
export function parseBoardSearch(search: BoardSearch): {
  filters: TaskFilters;
  layout: Layout;
} {
  const priority = str(search.priority);
  const due = str(search.due);
  const tags = str(search.tags);
  return {
    layout: search.view === "list" ? "list" : "board",
    filters: {
      search: str(search.q) ?? "",
      assignee: str(search.assignee),
      priority: PRIORITIES.includes(priority as TaskBoardItemPriority)
        ? (priority as TaskBoardItemPriority)
        : null,
      due: DUE_FILTERS.includes(due as DueFilter) ? (due as DueFilter) : null,
      tags: tags ? tags.split(",").filter(Boolean) : [],
      repo: str(search.repo),
    },
  };
}

/** Defaults are written as `undefined` so they drop out of the URL entirely. */
export function boardSearchParams(
  filters: TaskFilters,
  layout: Layout,
): Record<keyof BoardSearch, string | undefined> {
  return {
    view: layout === "list" ? "list" : undefined,
    q: filters.search === "" ? undefined : filters.search,
    assignee: filters.assignee ?? undefined,
    priority: filters.priority ?? undefined,
    due: filters.due ?? undefined,
    tags: filters.tags.length > 0 ? filters.tags.join(",") : undefined,
    repo: filters.repo ?? undefined,
  };
}

/** `useState`-shaped replacement for the board's filters + layout state. */
export function useBoardSearch() {
  const search = useSearch({ strict: false }) as BoardSearch;
  const navigate = useNavigate();
  const { filters, layout } = parseBoardSearch(search);

  const write = (nextFilters: TaskFilters, nextLayout: Layout) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...boardSearchParams(nextFilters, nextLayout),
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
