/**
 * The org's recently-opened apps, and the one way to add to them.
 *
 * Written from the ROUTE, not from the launcher tile. The tile used to be the
 * only event, on the theory that "apps I opened" meant "apps I clicked" — but a
 * pasted URL, a shared deep link and a back button all land you inside an app
 * the rail then refused to list, so the one column that is always on screen
 * could not take you back to the screen you were on.
 *
 * Backed by `useLocalStorage`, which is TanStack-Query-backed: the rail reads
 * the same key from a different corner of the tree and re-renders when this
 * writes, with no bus in between.
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
    /** A value written by an older build (or by hand) must not crash the rail
     *  that draws it. */
    recent: Array.isArray(recent) ? recent : EMPTY,
    remember: (entry) =>
      setRecent((prev) =>
        pushRecentApp(Array.isArray(prev) ? prev : [], entry),
      ),
  };
}

/** The app the current route IS, or null — a route with no launchable app
 *  (Today, the board, a settings page) so the rail is left alone. */
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
    /** Referentially stable across unrelated route state so the effect below
     *  fires once per app, not once per navigation. */
    structuralSharing: true,
  });
}

/**
 * Record the app the route is on, whichever way you got there.
 *
 * An effect and not a click handler because the event being observed IS the
 * navigation — there is no click to hang it on when the URL was typed. It is
 * keyed on the entry, so a re-render writes nothing and only a real change of
 * app or project touches storage.
 */
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
