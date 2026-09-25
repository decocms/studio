/**
 * The apps you opened last, newest first.
 *
 * The rail is the one column that is always on screen, so it is where "take me
 * back to the thing I was in" belongs. An app is only ever opened FROM a
 * project (`components/projects/project-apps.tsx` is the launcher), so an entry
 * is the pair — Site editor and Site editor of another project are two
 * different places to go back to.
 *
 * The project's title travels with the entry rather than being looked up when
 * the rail draws. The rail mounts on every screen in the product, including
 * ones that load no project at all, and a fleet-wide query to label four icons
 * is a poor trade; the cost is a renamed project keeping its old name in a
 * tooltip until it is opened again.
 *
 * Pure, and one entry per (app, project): reopening one MOVES it to the front
 * instead of stacking a second copy, which is what makes a four-slot list stay
 * useful instead of filling with the same icon.
 */

/** How many the rail keeps. Four is what fits under the orgs without the rail
 *  becoming a list of its own. */
const RECENT_APPS_LIMIT = 4;

export interface RecentApp {
  /** A `LaunchableViewId` — kept as a string here so this module does not
   *  depend on the launcher's catalogue; the rail drops any id it cannot
   *  resolve, which is also how a retired app leaves the list. */
  app: string;
  projectId: string;
  projectTitle: string;
}

function isSame(a: RecentApp, b: RecentApp): boolean {
  return a.app === b.app && a.projectId === b.projectId;
}

export function pushRecentApp(
  list: readonly RecentApp[],
  entry: RecentApp,
  limit: number = RECENT_APPS_LIMIT,
): RecentApp[] {
  return [entry, ...list.filter((it) => !isSame(it, entry))].slice(0, limit);
}
