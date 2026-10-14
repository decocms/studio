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
  /** A `LaunchableViewId` or `formatPinnedViewTabId` id; the rail drops unknown ids. */
  app: string;
  projectId: string;
  projectTitle: string;
  /** Set for a connection's app, which the catalogue cannot draw: its name
   *  and mark travel with the entry, as the project title does. */
  connection?: {
    id: string;
    toolName: string;
    label: string;
    icon?: string | null;
  };
}

function isSame(
  a: Pick<RecentApp, "app" | "projectId">,
  b: Pick<RecentApp, "app" | "projectId">,
): boolean {
  return a.app === b.app && a.projectId === b.projectId;
}

export function pushRecentApp(
  list: readonly RecentApp[],
  entry: RecentApp,
  limit: number = RECENT_APPS_LIMIT,
): RecentApp[] {
  return [entry, ...list.filter((it) => !isSame(it, entry))].slice(0, limit);
}

/** Closing a mark on the rail, as closing a tab. */
export function dropRecentApp(
  list: readonly RecentApp[],
  entry: Pick<RecentApp, "app" | "projectId">,
): RecentApp[] {
  return list.filter((it) => !isSame(it, entry));
}

/** Enough history to order an org's whole launcher, not just the rail. */
const APP_OPENS_LIMIT = 100;

/** One app in one project. `app` is a `LaunchableViewId` or a
 *  `formatPinnedViewTabId` id. */
export function appOpenKey(projectId: string, app: string): string {
  return JSON.stringify([projectId, app]);
}

export function pushAppOpen(
  list: readonly string[],
  key: string,
  limit: number = APP_OPENS_LIMIT,
): string[] {
  return [key, ...list.filter((it) => it !== key)].slice(0, limit);
}
