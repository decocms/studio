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

/** Enough history to order an org's whole launcher, not just the rail. */
const APP_OPENS_LIMIT = 100;

/** One app in one project. `app` is a `LaunchableViewId`, or
 *  `app:<connectionId>:<toolName>` for a pinned connection app. */
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

/** The app a route IS. `projectId` is null for the account-less
 *  `/site-editor` (`staticData.local`): the app is open, but no project (and
 *  no org) owns it, so it is marked on the rail and never recorded. */
export interface OpenApp {
  app: string;
  projectId: string | null;
}

interface RouteMatchLike {
  staticData: {
    mainView?: string;
    siteEditorView?: string;
    local?: boolean;
  };
  params?: unknown;
}

/** Which app the matched routes are, or null. The Site Editor's Preview,
 *  Content and Code tabs are routes of their own (`siteEditorView`) but one
 *  app. `isApp` is the launcher's catalogue, passed in so this module does not
 *  depend on it. Pure and tested. */
export function openAppOf(
  matches: readonly RouteMatchLike[],
  isApp: (app: string) => boolean,
): OpenApp | null {
  const match = matches.findLast((it) => it.staticData.mainView);
  if (!match) return null;
  const { mainView, siteEditorView, local } = match.staticData;
  const app = siteEditorView ? "site-editor" : mainView;
  if (!app || !isApp(app)) return null;
  const projectId = (match.params as { agentId?: string } | undefined)?.agentId;
  if (projectId) return { app, projectId };
  return local ? { app, projectId: null } : null;
}
