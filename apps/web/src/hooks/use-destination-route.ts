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
export const DESTINATION_ROUTE = {
  home: "/$org/home",
  /** One project's overview. Project identity is never carried in search. */
  projects: "/$org/projects/$agentId",
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

/** Canonical route tree below one project workspace. Keeping these literals in
 * one typed vocabulary makes every navigation caller agree with the router. */
export const PROJECT_ROUTE = {
  root: DESTINATION_ROUTE.projects,
  tasks: "/$org/projects/$agentId/tasks/{-$taskKey}",
  reports: "/$org/projects/$agentId/reports",
  siteEditor: "/$org/projects/$agentId/site-editor",
  siteEditorContent: "/$org/projects/$agentId/site-editor/content",
  siteEditorCode: "/$org/projects/$agentId/site-editor/code",
  automations: "/$org/projects/$agentId/automations",
  automation: "/$org/projects/$agentId/automations/$automationId",
  app: "/$org/projects/$agentId/apps/$connectionId/$toolName",
  view: "/$org/projects/$agentId/views/$viewId",
  outputFile: "/$org/projects/$agentId/outputs/file",
  outputDeck: "/$org/projects/$agentId/outputs/deck",
  libraryFile: "/$org/projects/$agentId/library/file",
  connectSources: "/$org/projects/$agentId/connect-sources",
  settings: "/$org/projects/$agentId/settings",
  assets: "/$org/projects/$agentId/assets",
  git: "/$org/projects/$agentId/git",
  hosting: "/$org/projects/$agentId/hosting",
  e2e: "/$org/projects/$agentId/e2e",
  analytics: "/$org/projects/$agentId/analytics",
  monitor: "/$org/projects/$agentId/cdn",
} as const;

export type DestinationRoutePath =
  (typeof DESTINATION_ROUTE)[keyof typeof DESTINATION_ROUTE];

/** The matched leaf route's full path, e.g. `"/$org/tasks/{-$taskKey}"`. */
export function useLeafRoutePath(): string {
  return useRouterState({
    select: (state) => state.matches.at(-1)?.fullPath ?? "",
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

/** The semantic view owned by the current route, used by the existing sidebar. */
export function useActivePanelSegment(): string | undefined {
  return useRouterState({
    select: (state) =>
      state.matches.findLast((match) => match.staticData.mainView)?.staticData
        .mainView,
  });
}
