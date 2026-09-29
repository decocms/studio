/**
 * You do not enter a project: the sidebar keeps the org's nav, and picking a
 * project opens one screen at `/$org/projects?project=…`. The scoped workspace
 * `/$org/projects/$agentId` is still routable through "Open full workspace".
 */

/** Compared against `useLeafRoutePath()` by anything reading `?project=` as a
 *  selection: neighbouring links spread the search forward, so the param
 *  outlives the screen that meant it. */
export const FLAT_PROJECT_ROUTE = "/$org/projects";
