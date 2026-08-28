/**
 * Reading and writing the main-panel view — the ONE place a tab id becomes a
 * URL, and the only writer of the `{-$panel}` segment.
 *
 * A view is opened by NAME, not by `to: "."`: the panel machinery renders on
 * every destination (the tab bar is in the shell header, the chat side panel
 * follows you around), so "open Preview" clicked from the Library has to land
 * on Preview's own address rather than leaving `/$org/library` in the URL
 * showing something else. The four views that ARE a destination page (Tasks,
 * Library, Reports, Home) navigate to that page for the same reason.
 *
 * Closing is the exception and stays `to: "."`: `?mainpanel=false` is layout,
 * it keeps the path — and therefore the view — so re-opening returns to it.
 */

import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  DESTINATION_ROUTE,
  type DestinationRoutePath,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import {
  type DestinationPanel,
  isDestinationPanel,
  panelLocationForTab,
  type PanelPayload,
  resolveChatSegments,
  tabIdForPanel,
} from "./panel-route";

/** Typed against the router's own paths, so a rename in `router.tsx` breaks here. */
const DESTINATION_ROUTE_BY_PANEL = {
  board: DESTINATION_ROUTE.tasks,
  files: DESTINATION_ROUTE.library,
  reports: DESTINATION_ROUTE.reports,
  overview: DESTINATION_ROUTE.home,
} as const satisfies Record<DestinationPanel, DestinationRoutePath>;

/** The view the URL names, as a tab id; `undefined` when it names none. */
export function useActivePanelTabId(): string | undefined {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false }) as PanelPayload;
  const { panel } = resolveChatSegments({
    project: params.project,
    panel: params.panel,
  });
  return tabIdForPanel(panel, search);
}

export interface OpenPanelOptions {
  /** Defaults to `true`: swapping the view is a layout write, not a place. */
  replace?: boolean;
  /** Scope the view to another project (the segment the chat route carries). */
  project?: string;
  /** Extra search the caller owns, applied under the panel's own payload. */
  search?: (prev: Record<string, unknown>) => Record<string, unknown>;
}

export function usePanelNavigate(): {
  openPanel: (tabId: string, opts?: OpenPanelOptions) => void;
  closePanel: (opts?: { replace?: boolean }) => void;
} {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const { project: currentProject } = resolveChatSegments({
    project: params.project,
    panel: params.panel,
  });
  const orgSlug = params.org ?? "";
  const onChatRoute = useLeafRoutePath() === DESTINATION_ROUTE.agents;
  /** The legacy `/$org/$taskId` keeps the thread in its path; every destination
   *  carries it in `?thread=`, so it has to move with the navigation. */
  const legacyThreadId = params.taskId;

  /**
   * Search is the page's, so only layout crosses a page boundary: leaving one
   * destination for another carries the thread and the chat panel and nothing
   * else. Two pages that both declare a key (`?preview=` on Chat and Library)
   * mean different things by it, and TanStack's own validator cannot tell them
   * apart. Staying put keeps the page's search intact.
   */
  const nextSearch =
    (payload: PanelPayload, samePage: boolean, opts?: OpenPanelOptions) =>
    (prev: Record<string, unknown>) => {
      const base: Record<string, unknown> = samePage
        ? { ...prev }
        : { thread: prev.thread, sidepanel: prev.sidepanel };
      if (legacyThreadId) base.thread = legacyThreadId;
      const next: Record<string, unknown> = {
        ...(opts?.search ? opts.search(base) : base),
        ...payload,
        /** An explicit `?mainpanel=false` is stale once a view is chosen. */
        mainpanel: undefined,
      };
      return next;
    };

  const openPanel = (tabId: string, opts?: OpenPanelOptions) => {
    const { panel, payload } = panelLocationForTab(tabId);
    const replace = opts?.replace ?? true;
    const toDestination = !!panel && isDestinationPanel(panel);
    const search = nextSearch(payload, onChatRoute && !toDestination, opts);

    if (panel && toDestination) {
      const to = DESTINATION_ROUTE_BY_PANEL[panel];
      if (to === DESTINATION_ROUTE.tasks) {
        navigate({
          to,
          params: { org: orgSlug, taskKey: undefined },
          search,
          replace,
        });
        return;
      }
      navigate({ to, params: { org: orgSlug }, search, replace });
      return;
    }

    navigate({
      to: DESTINATION_ROUTE.agents,
      params: {
        org: orgSlug,
        project: opts?.project ?? currentProject,
        panel,
      },
      search,
      replace,
    });
  };

  const closePanel = (opts?: { replace?: boolean }) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        mainpanel: false,
      }),
      replace: opts?.replace ?? true,
    });

  return { openPanel, closePanel };
}
