/**
 * useChatLayoutState — URL-driven state for the shared side panel and the
 * tabbed main panel.
 *
 * URL model:
 *   ?sidepanel=true         chat side panel open
 *   ?sidepanel=false        side panel closed
 *   ?sidepanel absent       route default, then agent-configured default
 *   ?sidepanel=chat|0       legacy links, parsed to the same boolean
 *   ?mainpanel=true|false   main panel open — the mirror of ?sidepanel
 *   ?mainpanel absent       open whenever the URL names a view (path segment,
 *                           route default, then agent-configured default)
 *   ?virtualmcpid           the agent, on the legacy `/$org/$taskId` alone
 *   ?thread                 the open thread on a destination route
 *
 * WHICH view the main panel shows is the `{-$panel}` path segment, not search —
 * see `main-panel-tabs/panel-route.ts`. So the two panel toggles here are pure
 * visibility: they navigate `to: "."` and never touch the path, which means a
 * closed panel still remembers its view and can never fabricate a thread id.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useRouteThreadId } from "@/layouts/thread-route";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useRouteDefaultMain } from "@/hooks/use-route-default-main";
import { useThreads } from "@/components/chat/store/hooks";
import { threadHasMessages } from "@/lib/thread-has-messages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityLayoutMetadata {
  defaultMainView?: {
    type: string;
    id?: string;
    toolName?: string;
  } | null;
  /** Open Chat in the side panel alongside a non-chat default main view. */
  chatDefaultOpen?: boolean | null;
  tabs?: Array<{ id: string }>;
}

export interface ChatLayoutState {
  threadOpen: boolean;
  contentOpen: boolean;
  /** Whether ?sidepanel was in the URL (vs. the agent-configured default). */
  threadVisibilityExplicit: boolean;
}

export interface ChatLayoutActions {
  toggleContent: () => void;
  toggleThread: () => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export interface ChatLayoutVisibility {
  threadOpen: boolean;
  contentOpen: boolean;
}

export type ChatLayoutPanelAction =
  | { type: "toggleThread" }
  | { type: "toggleContent" }
  | { type: "openThread" };

export type ChatLayoutPanelSearchUpdate = {
  sidepanel?: boolean;
  mainpanel?: boolean;
};

function withChatLayoutFallback(
  visibility: ChatLayoutVisibility,
): ChatLayoutVisibility {
  if (visibility.threadOpen || visibility.contentOpen) return visibility;
  return { ...visibility, threadOpen: true };
}

export function resolveDefaultPanelState(ctx: {
  entityMetadata: EntityLayoutMetadata | null;
  /** `?mainpanel`, when the URL carries one. */
  mainPanelParam?: boolean;
  /** Whether the `{-$panel}` path segment names a view. */
  panelNamed: boolean;
  threadVisibilityExplicit: boolean;
  sidePanelParamValue?: boolean;
  /** The destination route's default view (e.g. `board` on `/$org/tasks`).
   *  Wins over the agent's `defaultMainView`, loses to the path segment. */
  routeDefaultMain?: string | null;
  /** The current thread already holds a conversation. Forces the chat panel
   *  open even when the agent opts out of it (`chatDefaultOpen: false`), so
   *  returning to a chat you've been talking in never drops you on a closed
   *  panel. An empty composer (no thread / empty thread) leaves this false. */
  threadHasMessages?: boolean;
}): ChatLayoutVisibility {
  const defaultView = ctx.entityMetadata?.defaultMainView ?? null;
  const defaultIsChat = defaultView == null || defaultView.type === "chat";

  // The panel opens for any view the URL names — by path, by route, by agent.
  const contentOpen =
    ctx.mainPanelParam ??
    (ctx.panelNamed || !!ctx.routeDefaultMain || !defaultIsChat);
  /**
   * A destination route that names its own main view IS that view's page —
   * going to Tasks shows Tasks — so the chat starts collapsed beside it.
   * `/$org/agents` declares no `defaultMain`, which is exactly why chat keeps its
   * panel open without needing an exception here.
   */
  const defaultSidePanelOpen = ctx.routeDefaultMain
    ? false
    : defaultIsChat ||
      ctx.entityMetadata?.chatDefaultOpen === true ||
      ctx.threadHasMessages === true;
  const threadOpen = ctx.threadVisibilityExplicit
    ? ctx.sidePanelParamValue === true
    : defaultSidePanelOpen;

  return withChatLayoutFallback({ threadOpen, contentOpen });
}

export function resolveChatLayoutPanelAction(
  action: ChatLayoutPanelAction,
  visibility: ChatLayoutVisibility,
): ChatLayoutPanelSearchUpdate | null {
  switch (action.type) {
    case "toggleThread":
      if (visibility.threadOpen) {
        if (!visibility.contentOpen) return null;
        return { sidepanel: false };
      }
      return { sidepanel: true };
    case "toggleContent":
      if (visibility.contentOpen) {
        return { mainpanel: false, sidepanel: true };
      }
      return { mainpanel: true };
    case "openThread":
      return visibility.threadOpen ? null : { sidepanel: true };
  }
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

/**
 * Mobile shows ONE surface at a time, so `?sidepanel` and `?mainpanel` can't
 * both win. An explicit `?sidepanel=true` does: it only ever gets written by an
 * intentional "open the chat" action (openThread, the mobile view select),
 * and before this it was a silent no-op whenever the main panel happened to be
 * open — tapping Chat left you on the Preview view, booting a sandbox.
 * With no `?sidepanel` in the URL the panel state is the agent-configured
 * default, and there the main view keeps precedence.
 */
export function resolveMobileSurface(ctx: {
  visibility: ChatLayoutVisibility;
  threadVisibilityExplicit: boolean;
}): MobileChatLayoutSurface {
  const { threadOpen, contentOpen } = ctx.visibility;
  if (threadOpen && (ctx.threadVisibilityExplicit || !contentOpen))
    return "chat";
  return contentOpen ? "main" : "chat";
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
  const { threads } = useThreads();

  const routeDefaultMain = useRouteDefaultMain();
  const panelTabId = useActivePanelTabId();

  const threadId = useRouteThreadId();

  // Reopen the chat for a thread that already holds a conversation (threadHasMessages).
  const currentThread =
    threadId != null ? threads.find((t) => t.id === threadId) : undefined;

  const { threadOpen, contentOpen } = resolveDefaultPanelState({
    entityMetadata,
    mainPanelParam: search.mainpanel,
    panelNamed: panelTabId !== undefined,
    threadVisibilityExplicit: search.sidepanel !== undefined,
    sidePanelParamValue: search.sidepanel,
    routeDefaultMain,
    threadHasMessages: currentThread ? threadHasMessages(currentThread) : false,
  });
  const visibility = { threadOpen, contentOpen };

  /**
   * Panel state is search, never path: `to: "."` re-interpolates the matched
   * route's own params, so every toggle below stays on the current page.
   */
  const navigateSearch = (
    updates: Record<string, unknown>,
    options?: { replace?: boolean },
  ) => {
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...updates }),
      replace: options?.replace ?? false,
    });
  };

  const toggleContent = () => {
    const update = resolveChatLayoutPanelAction(
      { type: "toggleContent" },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
  };

  const toggleThread = () => {
    const update = resolveChatLayoutPanelAction(
      { type: "toggleThread" },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
  };

  return {
    threadOpen,
    contentOpen,
    threadVisibilityExplicit: search.sidepanel !== undefined,
    toggleContent,
    toggleThread,
  };
}
