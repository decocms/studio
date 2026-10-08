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

/** The app a route IS. `projectId` is null for the account-less
 *  `/site-editor` (`staticData.local`): the app is open, but no project (and
 *  no org) owns it, so it is marked on the rail and never recorded.
 *  `connection` is set for a connection's app (a pinned view). */
export interface OpenApp {
  app: string;
  projectId: string | null;
  connection?: { id: string; toolName: string };
}

interface RouteMatchLike {
  staticData: {
    mainView?: string;
    siteEditorView?: string;
    local?: boolean;
  };
  params?: unknown;
}

/** Which app the matched routes are, a connection's app included, or null.
 *  The Site Editor's Preview, Content and Code tabs (`siteEditorView`) are
 *  all the Site Editor, in a project and in the account-less `/site-editor`.
 *  `isApp` is the launcher's catalogue and `connectionApp` the pinned view's
 *  tab id, passed in so this module does not depend on either. Pure and
 *  tested. */
export function openAppOf(
  matches: readonly RouteMatchLike[],
  isApp: (app: string) => boolean,
  connectionApp: (connectionId: string, toolName: string) => string,
): OpenApp | null {
  const match = matches.findLast((it) => it.staticData.mainView);
  if (!match) return null;
  const { mainView, siteEditorView, local } = match.staticData;
  if (!mainView) return null;
  const params = match.params as
    | { agentId?: string; connectionId?: string; toolName?: string }
    | undefined;
  const projectId = params?.agentId;
  if (
    projectId &&
    mainView === "app" &&
    params.connectionId &&
    params.toolName
  ) {
    return {
      app: connectionApp(params.connectionId, params.toolName),
      projectId,
      connection: { id: params.connectionId, toolName: params.toolName },
    };
  }
  const app = siteEditorView ? "site-editor" : mainView;
  if (!isApp(app)) return null;
  if (projectId) return { app, projectId };
  return local ? { app, projectId: null } : null;
}
