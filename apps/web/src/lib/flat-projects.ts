/**
 * The flat shape, which is now simply the shape.
 *
 * You do not enter a project: the sidebar keeps the organization's nav and its
 * project tree, and picking one opens a single screen — its signals, its apps,
 * and its board — at `/$org/projects?project=…`.
 *
 * The scoped workspace (`/$org/projects/$agentId`) still exists and is still
 * routable; the flat screen's "Open full workspace" is the deliberate door to
 * it. What is gone is the demo switch that used to choose between the two.
 */

/**
 * The flat screen's own route path — `/$org/projects` with no `$agentId`.
 *
 * Compared against `useLeafRoutePath()` by anything that reads `?project=` as
 * a SELECTION rather than as a leftover. Neighbouring links spread the current
 * search forward, so the param outlives the screen that means it; the path is
 * what says the screen is actually showing.
 */
export const FLAT_PROJECT_ROUTE = "/$org/projects";
