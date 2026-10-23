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
  dropRecentApp,
  openAppOf,
  type OpenApp,
  pushRecentApp,
  type RecentApp,
} from "@/lib/recent-apps";
import { useVirtualMCPNonBlocking } from "@/sdk";

const EMPTY: RecentApp[] = [];

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

/** The app the current route IS, a connection's app included, or null for a
 *  route with no launchable app. See `openAppOf`. */
export function useOpenApp(): OpenApp | null {
  return useRouterState({
    select: (state) =>
      openAppOf(
        state.matches,
        (app) => app in PROJECT_APPS,
        formatPinnedViewTabId,
      ),
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
  /** By id, not the project scope: the scope drops projects its picker does
   *  not offer, and an app opened in one of those never reached the rail.
   *  No project, no entry: the account-less `/site-editor` is never
   *  recorded. */
  const project = useVirtualMCPNonBlocking(open?.projectId);
  const title =
    open?.projectId && project?.id === open.projectId ? project.title : null;
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
    if (!open?.projectId || !title) return;
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
