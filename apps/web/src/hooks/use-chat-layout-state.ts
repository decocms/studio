/** The chat never closes; full screen hides it, either the person's persisted
 *  preference or a project that opens with the chat closed. */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useRouteDefaultMain } from "@/hooks/use-route-default-main";
import { usePreferences } from "@/hooks/use-preferences";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityLayoutMetadata {
  defaultMainView?: {
    type: string;
    id?: string;
    toolName?: string;
  } | null;
  /** Open the chat beside the main view on arrival. Unset means open. */
  chatDefaultOpen?: boolean | null;
  tabs?: Array<{ id: string }>;
}

export interface ChatLayoutState {
  threadOpen: boolean;
  contentOpen: boolean;
  /** `?sidepanel` as written in the URL, for the mobile surface choice. */
  sidePanelParam?: boolean;
}

export interface ChatLayoutActions {
  toggleContent: () => void;
  /** Expands the main panel over the chat, or brings the chat back. */
  toggleFullscreen: () => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export interface ChatLayoutVisibility {
  threadOpen: boolean;
  contentOpen: boolean;
}

export type ChatLayoutPanelSearchUpdate = {
  sidepanel?: boolean;
  mainpanel?: boolean;
};

export function resolveDefaultPanelState(ctx: {
  entityMetadata: EntityLayoutMetadata | null;
  /** `?mainpanel`, when the URL carries one. */
  mainPanelParam?: boolean;
  /** Whether the `{-$panel}` path segment names a view. */
  panelNamed: boolean;
  /** `?sidepanel`, when the URL carries one. */
  sidePanelParam?: boolean;
  /** The destination route's default view (e.g. `board` on `/$org/tasks`).
   *  Wins over the agent's `defaultMainView`, loses to the path segment. */
  routeDefaultMain?: string | null;
  /** The person keeps the main panel expanded over the chat. */
  contentFullscreen: boolean;
}): ChatLayoutVisibility {
  const defaultView = ctx.entityMetadata?.defaultMainView ?? null;
  const defaultIsChat = defaultView == null || defaultView.type === "chat";

  // The panel opens for any view the URL names — by path, by route, by agent.
  const contentOpen =
    ctx.mainPanelParam ??
    (ctx.panelNamed || !!ctx.routeDefaultMain || !defaultIsChat);
  // Without a main panel there is nothing to expand: the chat fills the space.
  const threadOpen =
    !contentOpen ||
    ctx.sidePanelParam === true ||
    (!ctx.contentFullscreen && ctx.entityMetadata?.chatDefaultOpen !== false);

  return { threadOpen, contentOpen };
}

export interface ChatLayoutPanelSizes {
  side: number;
  main: number;
}

export function computeChatLayoutPanelSizes(
  visibility: ChatLayoutVisibility,
): ChatLayoutPanelSizes {
  if (visibility.threadOpen && visibility.contentOpen) {
    return { side: 33, main: 67 };
  }
  if (visibility.threadOpen) return { side: 100, main: 0 };
  if (visibility.contentOpen) return { side: 0, main: 100 };
  return { side: 0, main: 0 };
}

export type MobileChatLayoutSurface = "chat" | "main";

/** Mobile shows one surface; only an explicit `?sidepanel=true` beats an open main view. */
export function resolveMobileSurface(ctx: {
  contentOpen: boolean;
  sidePanelParam?: boolean;
}): MobileChatLayoutSurface {
  if (ctx.sidePanelParam === true || !ctx.contentOpen) return "chat";
  return "main";
}

export function mobileSurfaceSearch(
  surface: MobileChatLayoutSurface,
): Required<ChatLayoutPanelSearchUpdate> {
  if (surface === "main") return { sidepanel: false, mainpanel: true };
  return { sidepanel: true, mainpanel: false };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Asserted against the router's own search type, so widening either key is a compile error. */
type PanelSearchParams = {
  sidepanel?: boolean;
  mainpanel?: boolean;
};

export function useChatLayoutState(
  entityMetadata: EntityLayoutMetadata | null,
): ChatLayoutState & ChatLayoutActions {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) satisfies PanelSearchParams;
  const [preferences, setPreferences] = usePreferences();

  const routeDefaultMain = useRouteDefaultMain();
  const panelTabId = useActivePanelTabId();

  const { threadOpen, contentOpen } = resolveDefaultPanelState({
    entityMetadata,
    mainPanelParam: search.mainpanel,
    panelNamed: panelTabId !== undefined,
    sidePanelParam: search.sidepanel,
    routeDefaultMain,
    contentFullscreen: preferences.contentFullscreen,
  });

  /**
   * Panel state is search, never path: `to: "."` re-interpolates the matched
   * route's own params, so every toggle below stays on the current page.
   */
  const navigateSearch = (updates: ChatLayoutPanelSearchUpdate) => {
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...updates }),
      replace: true,
    });
  };

  const toggleContent = () => {
    navigateSearch({ mainpanel: !contentOpen });
  };

  const toggleFullscreen = () => {
    setPreferences((prev) => ({ ...prev, contentFullscreen: threadOpen }));
    // A project that opens with the chat closed still hides it after the
    // preference clears, so showing it there needs `?sidepanel` too.
    const sidepanel =
      !threadOpen && entityMetadata?.chatDefaultOpen === false
        ? true
        : undefined;
    if (search.sidepanel !== sidepanel) navigateSearch({ sidepanel });
  };

  return {
    threadOpen,
    contentOpen,
    sidePanelParam: search.sidepanel,
    toggleContent,
    toggleFullscreen,
  };
}
