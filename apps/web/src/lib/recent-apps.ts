/**
 * The apps you opened last, newest first. An entry is the (app, project) pair,
 * since an app is always opened from a project.
 *
 * The project's title travels with the entry rather than being looked up: the
 * rail mounts on screens that load no project, and a fleet-wide query to label
 * four icons is a poor trade. A renamed project keeps its old name until
 * reopened.
 */

/** What fits under the orgs without the rail becoming a list of its own. */
const RECENT_APPS_LIMIT = 4;

export interface RecentApp {
  /** A `LaunchableViewId`, as a string so this module does not depend on the
   *  launcher's catalogue. The rail drops ids it cannot resolve. */
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
