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
  sprint?: string;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

/** Anything unrecognized in the URL is dropped, not trusted. `filters.repo` is
 *  an explicit exact-match choice; the project scope is separate and inclusive
 *  — see `taskMatchesScope`. */
export function parseBoardSearch(search: BoardSearch): {
  filters: TaskFilters;
  layout: Layout;
} {
  const priority = str(search.priority);
  const due = str(search.due);
  const tags = str(search.tags);
  const sprint = str(search.sprint);
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
      sprint: sprint,
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
    sprint: filters.sprint ?? undefined,
  };
}

/** Whether a card survives the active project scope. INCLUSIVE: hides other
 *  projects' work, never unclassified work — `repo` is a routing hint, and is
 *  null on every reports-imported and Jira-synced card. Case-insensitive, as
 *  GitHub is. */
export function taskMatchesScope(
  item: { repo?: string | null },
  scopeRepo: string | null,
): boolean {
  if (!scopeRepo) return true;
  if (item.repo == null) return true;
  return item.repo.toLowerCase() === scopeRepo.toLowerCase();
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
