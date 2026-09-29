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
import { useProjectScope } from "./use-project-scope.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { PROJECT_APPS } from "@/components/projects/project-apps";
import { pushRecentApp, type RecentApp } from "@/lib/recent-apps";

const EMPTY: RecentApp[] = [];

export function useRecentApps(orgSlug: string): {
  recent: RecentApp[];
  remember: (entry: RecentApp) => void;
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
  };
}

/** The app the current route IS, or null for a route with no launchable
 *  app. */
export function useOpenApp(): { app: string; projectId: string } | null {
  return useRouterState({
    select: (state) => {
      const match = state.matches.findLast((it) => it.staticData.mainView);
      const app = match?.staticData.mainView;
      const projectId = (match?.params as { agentId?: string } | undefined)
        ?.agentId;
      if (!app || !projectId) return null;
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
  const { project } = useProjectScope();
  const title = open && project?.id === open.projectId ? project.title : null;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- the event is the navigation itself; a deep link has no click to record on
  useEffect(() => {
    if (!open || !title) return;
    remember({ app: open.app, projectId: open.projectId, projectTitle: title });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `remember` is a fresh closure each render; the entry is the identity that matters
  }, [orgSlug, open?.app, open?.projectId, title]);
}
