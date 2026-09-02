/**
 * The destination routes, addressed by their full path.
 *
 * Path = which page, search = how that page is laid out. So "which destination
 * am I on" is answered by the matched leaf route, never by the view — that is
 * panel visibility and can read `0` (closed) on any page.
 *
 * The strings here are the `path` values registered in `router.tsx`; TanStack's
 * `fullPath` on a match is exactly that path with the pathless layout ids
 * elided, so a leaf match on `/$org/home` compares equal to `DESTINATION_ROUTE.home`.
 * They are typed `as const` and fed straight to `<Link to>` / `navigate({ to })`,
 * which means a rename in `router.tsx` is a compile error here.
 */

import { useRouterState } from "@tanstack/react-router";
import { normalizePanelSegment } from "@/layouts/main-panel-tabs/tab-id";

export const DESTINATION_ROUTE = {
  home: "/$org/home",
  agents: "/$org/agents/{-$panel}",
  tasks: "/$org/tasks/{-$taskKey}",
  reports: "/$org/reports",
  library: "/$org/library",
  discover: "/$org/discover",
  /** The `/$org` resolver. Transiently matched before it redirects, so Home
   *  highlights there instead of leaving the list blank on cold entry. */
  orgIndex: "/$org/",
  /** The legacy thread route, mounted forever. */
  legacyThread: "/$org/$taskId",
} as const;

export type DestinationRoutePath =
  (typeof DESTINATION_ROUTE)[keyof typeof DESTINATION_ROUTE];

/** The matched leaf route's full path, e.g. `"/$org/tasks/{-$taskKey}"`. */
export function useLeafRoutePath(): string {
  return useRouterState({
    select: (state) => state.matches.at(-1)?.fullPath ?? "",
  });
}

/** Which main-panel view the matched route names in `{-$panel}` (e.g.
 *  `"settings"`), for the sidebar rows that highlight off it; `undefined` where
 *  a route has no panel segment. Normalised, so a bookmark on a renamed segment
 *  still lights the row that now owns that view. Read with
 *  {@link useLeafRoutePath} — only the projects route means "view" by it. */
export function useActivePanelSegment(): string | undefined {
  return useRouterState({
    select: (state) => {
      const panel = (state.matches.at(-1)?.params as { panel?: string })?.panel;
      return panel === undefined ? undefined : normalizePanelSegment(panel);
    },
  });
}

/** Which side of the project scope a destination is bound to, for the two that
 *  are: `"project-only"` cannot be shown for the whole org, `"org-only"` cannot
 *  be narrowed to one project. */
type ScopeBinding = "project-only" | "org-only";

/** The destinations bound to one side of the scope — the ONE place that fact
 *  lives. A project is a filter, so most pages exist on both sides of it and
 *  this map names only the two that do not: Library lists the ORG's files, and
 *  a report is about one site. It is keyed by route path because the consumers
 *  are keyed by route path too: the sidebar drops the row a scope invalidates
 *  (`nav-destinations.tsx`), and `useExitProjectScope` must not leave you on a
 *  page the scope it just cleared was the only way to reach. Two hand-kept
 *  lists would drift the first time a destination is added; this one cannot,
 *  and its entries are typed `DestinationRoutePath`, so a route renamed in
 *  `DESTINATION_ROUTE` is a compile error here. */
const SCOPE_BOUND_ROUTES: ReadonlyMap<string, ScopeBinding> = new Map<
  DestinationRoutePath,
  ScopeBinding
>([
  [DESTINATION_ROUTE.reports, "project-only"],
  [DESTINATION_ROUTE.library, "org-only"],
]);

/** Whether `path` names a page that exists under `scopeId` — `null` being the
 *  organization itself. Unbound destinations exist on both sides, so the answer
 *  is `true` for everything the map does not name. */
export function routeExistsInScope(
  path: string,
  scopeId: string | null,
): boolean {
  const binding = SCOPE_BOUND_ROUTES.get(path);
  if (binding === undefined) return true;
  return binding === "project-only" ? scopeId !== null : scopeId === null;
}
