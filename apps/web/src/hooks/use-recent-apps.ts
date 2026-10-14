/**
 * The org's recently-opened apps. Written from the ROUTE, not the launcher
 * tile, so a pasted URL or a back button still counts as having been there.
 *
 * Backed by `useLocalStorage` (TanStack-Query-backed), so the rail re-renders
 * on write with no bus in between.
 */

import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useLocalStorage } from "./use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { PROJECT_APPS } from "@/components/projects/project-apps";
import { pinnedViewsOf } from "@/layouts/main-panel-tabs/attached-pinned-views";
import { formatPinnedViewTabId } from "@/layouts/main-panel-tabs/tab-id";
import {
  appOpenKey,
  dropRecentApp,
  pushAppOpen,
  pushRecentApp,
  type RecentApp,
} from "@/lib/recent-apps";
import { useVirtualMCPNonBlocking } from "@/sdk";

const EMPTY: RecentApp[] = [];
const NO_OPENS: string[] = [];

/** Every app opened in the org, newest first, as `appOpenKey`s. */
export function useAppOpens(orgSlug: string): {
  opens: string[];
  remember: (key: string) => void;
} {
  const [opens, setOpens] = useLocalStorage<string[]>(
    LOCALSTORAGE_KEYS.appOpens(orgSlug),
    NO_OPENS,
  );
  return {
    /** A value from an older build must not crash the home. */
    opens: Array.isArray(opens) ? opens : NO_OPENS,
    remember: (key) =>
      setOpens((prev) => pushAppOpen(Array.isArray(prev) ? prev : [], key)),
  };
}

export function useRecentApps(orgSlug: string): {
  recent: RecentApp[];
  remember: (entry: RecentApp) => void;
  forget: (entry: Pick<RecentApp, "app" | "projectId">) => void;
} {
  const [recent, setRecent] = useLocalStorage<RecentApp[]>(
    LOCALSTORAGE_KEYS.recentApps(orgSlug),
    EMPTY,
  );

  return {
    /** A value from an older build must not crash the rail. */
    recent: Array.isArray(recent) ? recent : EMPTY,
    remember: (entry) =>
      setRecent((prev) =>
        pushRecentApp(Array.isArray(prev) ? prev : [], entry),
      ),
    forget: (entry) =>
      setRecent((prev) =>
        dropRecentApp(Array.isArray(prev) ? prev : [], entry),
      ),
  };
}

interface OpenApp {
  app: string;
  projectId: string;
  connection?: { id: string; toolName: string };
}

/** The app the current route IS, a connection's app included, or null for a
 *  route with no launchable app. */
export function useOpenApp(): OpenApp | null {
  return useRouterState({
    select: (state): OpenApp | null => {
      const match = state.matches.findLast((it) => it.staticData.mainView);
      const view = match?.staticData.mainView;
      const params = match?.params as
        | { agentId?: string; connectionId?: string; toolName?: string }
        | undefined;
      const projectId = params?.agentId;
      if (!view || !projectId) return null;
      if (view === "app" && params.connectionId && params.toolName) {
        return {
          app: formatPinnedViewTabId(params.connectionId, params.toolName),
          projectId,
          connection: { id: params.connectionId, toolName: params.toolName },
        };
      }
      /** Content and Code are tabs of the Site Editor, not apps of their own. */
      const app = match.staticData.siteEditorView ? "site-editor" : view;
      return app in PROJECT_APPS ? { app, projectId } : null;
    },
    /** Stable across unrelated route state, so the effect fires once per app
     *  rather than once per navigation. */
    structuralSharing: true,
  });
}

/** Record the app the route is on. An effect, not a click handler: a typed URL
 *  has no click. Keyed on the entry, so a re-render writes nothing. */
export function useRememberOpenApp(orgSlug: string): void {
  const { remember } = useRecentApps(orgSlug);
  const open = useOpenApp();
  const opens = useAppOpens(orgSlug);
  /** By id, not the project scope: the scope drops projects its picker does
   *  not offer, and an app opened in one of those never reached the rail. */
  const project = useVirtualMCPNonBlocking(open?.projectId);
  const title = open && project?.id === open.projectId ? project.title : null;
  const pinned =
    open?.connection && project
      ? pinnedViewsOf(project).find(
          (pv) =>
            pv.connectionId === open.connection?.id &&
            pv.toolName === open.connection.toolName,
        )
      : undefined;
  const connection = open?.connection && {
    id: open.connection.id,
    toolName: open.connection.toolName,
    label: pinned?.label || open.connection.toolName,
    icon: pinned?.icon,
  };

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- the event is the navigation itself; a deep link has no click to record on
  useEffect(() => {
    if (open) opens.remember(appOpenKey(open.projectId, open.app));
    if (!open || !title) return;
    remember({
      app: open.app,
      projectId: open.projectId,
      projectTitle: title,
      ...(connection && { connection }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `remember` is a fresh closure each render; the entry is the identity that matters
  }, [
    orgSlug,
    open?.app,
    open?.projectId,
    title,
    connection?.label,
    connection?.icon,
  ]);
}
