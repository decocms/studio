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
  /** One agent's overview. Agent identity is never carried in search. */
  agents: "/$org/agents/$agentId",
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

/** Canonical route tree below one agent workspace. Keeping these literals in
 * one typed vocabulary makes every navigation caller agree with the router. */
export const AGENT_ROUTE = {
  root: DESTINATION_ROUTE.agents,
  siteEditor: "/$org/agents/$agentId/site-editor",
  siteEditorContent: "/$org/agents/$agentId/site-editor/content",
  siteEditorCode: "/$org/agents/$agentId/site-editor/code",
  automations: "/$org/agents/$agentId/automations",
  automation: "/$org/agents/$agentId/automations/$automationId",
  app: "/$org/agents/$agentId/apps/$connectionId/$toolName",
  view: "/$org/agents/$agentId/views/$viewId",
  outputFile: "/$org/agents/$agentId/outputs/file",
  outputDeck: "/$org/agents/$agentId/outputs/deck",
  libraryFile: "/$org/agents/$agentId/library/file",
  connectSources: "/$org/agents/$agentId/connect-sources",
  settings: "/$org/agents/$agentId/settings",
  assets: "/$org/agents/$agentId/assets",
  git: "/$org/agents/$agentId/git",
  hosting: "/$org/agents/$agentId/hosting",
  e2e: "/$org/agents/$agentId/e2e",
  analytics: "/$org/agents/$agentId/analytics",
  monitor: "/$org/agents/$agentId/cdn",
} as const;

/** The matched leaf route's full path, e.g. `"/$org/tasks/{-$taskKey}"`. */
export function useLeafRoutePath(): string {
  return useRouterState({
    select: (state) => state.matches.at(-1)?.fullPath ?? "",
  });
}
