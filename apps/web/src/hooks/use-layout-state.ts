/**
 * useWorkspaceLayoutState — Querystring-driven state for the shared side
 * panel and the tabbed main panel.
 *
 * URL model:
 *   ?sidepanel=true         chat side panel open
 *   ?sidepanel=false        side panel closed
 *   ?sidepanel absent       route default, then agent-configured default
 *   ?sidepanel=chat|0       legacy links, parsed to the same boolean
 *   ?main=<tabId>           main panel open, tab active
 *   ?main=0                 main panel closed
 *   ?main absent            route default, then agent-configured default
 *   ?virtualmcpid           which MCP the workspace is scoped to
 *   ?thread                 the open thread on a destination route
 *
 * Panel actions navigate `to: "."` — layout is search, never path — so a toggle
 * stays on the matched route and can never fabricate a thread id. Only the two
 * thread-changing actions go through `useThreadNavigate`, which puts the id in
 * the path on the legacy `/$org/$taskId` and in `?thread=` everywhere else.
 */

import { useRef } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { resolveDefaultTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useRouteDefaultMain } from "@/hooks/use-route-default-main";
import { useRouteThreadId, useThreadNavigate } from "@/layouts/thread-route";
import { useThreadActions, useThreads } from "@/components/chat/store/hooks";

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

export interface WorkspaceLayoutState {
  /** The open thread, or `null` on a destination route that names none. */
  threadId: string | null;
  /** React `key` for the workspace providers — identity, never a thread id. */
  providerKey: string;
  sidePanelOpen: boolean;
  mainOpen: boolean;
  /** Current ?main value (undefined when param absent). "0" = closed. */
  mainParam: string | undefined;
  /** Whether ?sidepanel was in the URL (vs. the agent-configured default). */
  sidePanelParamPresent: boolean;
}

export interface WorkspaceLayoutActions {
  setTaskId: (id: string, virtualMcpId?: string) => void;
  toggleMain: () => void;
  toggleSidePanel: () => void;
  setMobileSurface: (surface: MobileWorkspaceSurface) => void;
  openSidePanel: () => void;
  createNewTask: () => void;
  openTab: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export type WorkspacePanel = "side" | "main";

export interface WorkspaceVisibility {
  sidePanelOpen: boolean;
  mainOpen: boolean;
}

export type WorkspacePanelAction =
  | { type: "toggleSidePanel" }
  | { type: "toggleMain"; openMainValue: string }
  | { type: "openSidePanel" };

export type WorkspacePanelSearchUpdate = {
  sidepanel?: boolean;
  main?: string | 0;
};

/** {@link WorkspaceLayoutState}'s thread fields, split so neither can stand in
 *  for the other. */
export interface WorkspaceThread {
  threadId: string | null;
  providerKey: string;
}

/**
 * Pure core of the workspace's thread identity.
 *
 * A destination route names no thread until one is opened, but the providers
 * below it still need a stable React `key` so a later switch remounts them.
 * Those are two different values: `providerKey` falls back to a client-side id
 * so the tree keeps its identity, while `threadId` stays `null` so nothing can
 * stream, fetch or report against a thread that does not exist.
 */
export function resolveWorkspaceThread(input: {
  routeThreadId: string | null;
  /** Client-side id, stable for the life of the mount. Never a thread. */
  fallbackKey: string;
}): WorkspaceThread {
  return {
    threadId: input.routeThreadId,
    providerKey: input.routeThreadId ?? input.fallbackKey,
  };
}

export function canCloseWorkspacePanel(
  panel: WorkspacePanel,
  visibility: WorkspaceVisibility,
): boolean {
  const openPanelCount =
    Number(visibility.sidePanelOpen) + Number(visibility.mainOpen);

  if (openPanelCount <= 1) return false;
  return panel === "side" ? visibility.sidePanelOpen : visibility.mainOpen;
}

function withWorkspaceFallback(
  visibility: WorkspaceVisibility,
): WorkspaceVisibility {
  if (visibility.sidePanelOpen || visibility.mainOpen) return visibility;
  return { ...visibility, sidePanelOpen: true };
}

export function resolveDefaultPanelState(ctx: {
  entityMetadata: EntityLayoutMetadata | null;
  mainParamPresent: boolean;
  mainParamValue?: string | 0;
  sidePanelParamPresent: boolean;
  sidePanelParamValue?: boolean;
  /** The destination route's default `?main` (e.g. `board` on `/$org/tasks`).
   *  Wins over the agent's `defaultMainView`, loses to an explicit `?main=`. */
  routeDefaultMain?: string | null;
}): WorkspaceVisibility {
  const mainParamValue = ctx.mainParamValue === 0 ? "0" : ctx.mainParamValue;
  const defaultView = ctx.entityMetadata?.defaultMainView ?? null;
  const defaultIsChat = defaultView == null || defaultView.type === "chat";

  // A route default names a real view, so the panel opens on it.
  const mainOpen = ctx.mainParamPresent
    ? mainParamValue !== "0"
    : ctx.routeDefaultMain
      ? true
      : !defaultIsChat;
  /**
   * A destination route that names its own main view IS that view's page —
   * going to Tasks shows Tasks — so the chat starts collapsed beside it.
   * `/$org/chat` declares no `defaultMain`, which is exactly why chat keeps its
   * panel open without needing an exception here.
   */
  const defaultSidePanelOpen = ctx.routeDefaultMain
    ? false
    : defaultIsChat || ctx.entityMetadata?.chatDefaultOpen === true;
  const sidePanelOpen = ctx.sidePanelParamPresent
    ? ctx.sidePanelParamValue === true
    : defaultSidePanelOpen;

  return withWorkspaceFallback({ sidePanelOpen, mainOpen });
}

export function resolveWorkspacePanelAction(
  action: WorkspacePanelAction,
  visibility: WorkspaceVisibility,
): WorkspacePanelSearchUpdate | null {
  switch (action.type) {
    case "toggleSidePanel":
      if (visibility.sidePanelOpen) {
        if (!canCloseWorkspacePanel("side", visibility)) return null;
        return { sidepanel: false };
      }
      return { sidepanel: true };
    case "toggleMain":
      if (visibility.mainOpen) {
        if (!canCloseWorkspacePanel("main", visibility)) return null;
        return { main: 0 };
      }
      return { main: action.openMainValue };
    case "openSidePanel":
      return visibility.sidePanelOpen ? null : { sidepanel: true };
  }
}

export interface WorkspacePanelSizes {
  side: number;
  main: number;
}

export function computeWorkspacePanelSizes(
  visibility: WorkspaceVisibility,
): WorkspacePanelSizes {
  if (visibility.sidePanelOpen && visibility.mainOpen) {
    return { side: 33, main: 67 };
  }
  if (visibility.sidePanelOpen) return { side: 100, main: 0 };
  if (visibility.mainOpen) return { side: 0, main: 100 };
  return { side: 0, main: 0 };
}

export type MobileWorkspaceSurface = "chat" | "main";

/**
 * Mobile shows ONE surface at a time, so `?sidepanel` and `?main` can't both
 * win. An explicit `?sidepanel=true` does: it only ever gets written by an
 * intentional "open the chat" action (openSidePanel, the mobile view select),
 * and before this it was a silent no-op whenever the main panel happened to be
 * open — tapping Chat left you on ?main=preview, booting a sandbox.
 * With no `?sidepanel` in the URL the panel state is the agent-configured
 * default, and there the main view keeps precedence.
 */
export function resolveMobileSurface(ctx: {
  visibility: WorkspaceVisibility;
  sidePanelParamPresent: boolean;
}): MobileWorkspaceSurface {
  const { sidePanelOpen, mainOpen } = ctx.visibility;
  if (sidePanelOpen && (ctx.sidePanelParamPresent || !mainOpen)) return "chat";
  return mainOpen ? "main" : "chat";
}

export function mobileSurfaceSearch(
  surface: MobileWorkspaceSurface,
  mainTabId: string,
): Required<Pick<WorkspacePanelSearchUpdate, "sidepanel" | "main">> {
  if (surface === "main") return { sidepanel: false, main: mainTabId };
  return { sidepanel: true, main: 0 };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Asserted against the router's own search type, so widening either key is a compile error. */
type PanelSearchParams = {
  sidepanel?: boolean;
  main?: string | 0;
};

export interface WorkspaceLayoutStateRouteCtx {
  virtualMcpId: string;
  isAgentRoute: boolean;
}

export function useWorkspaceLayoutState(
  entityMetadata: EntityLayoutMetadata | null,
  routeCtx: WorkspaceLayoutStateRouteCtx,
): WorkspaceLayoutState & WorkspaceLayoutActions {
  const navigate = useNavigate();
  const navigateThread = useThreadNavigate();
  const search = useSearch({ strict: false }) satisfies PanelSearchParams;
  const routeParamsRaw = useParams({ strict: false });
  const { create } = useThreadActions();
  const { threads } = useThreads();

  const { virtualMcpId, isAgentRoute } = routeCtx;
  const mainParam = search.main === 0 ? "0" : search.main;
  const routeDefaultMain = useRouteDefaultMain();
  const defaultTabId = routeDefaultMain || resolveDefaultTabId(entityMetadata);

  const { sidePanelOpen, mainOpen } = resolveDefaultPanelState({
    entityMetadata,
    mainParamPresent: search.main !== undefined,
    mainParamValue: mainParam,
    sidePanelParamPresent: search.sidepanel !== undefined,
    sidePanelParamValue: search.sidepanel,
    routeDefaultMain,
  });
  const visibility = { sidePanelOpen, mainOpen };

  const routeThreadId = useRouteThreadId();
  const fallbackRef = useRef(crypto.randomUUID());
  const { threadId, providerKey } = resolveWorkspaceThread({
    routeThreadId,
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    fallbackKey: fallbackRef.current,
  });

  /** Redundant once the agent is the `{-$project}` path segment, which `to: "."` carries forward. */
  const preserveVirtualMcp =
    isAgentRoute && !routeParamsRaw.project
      ? { virtualmcpid: virtualMcpId }
      : {};

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

  const setTaskId = (id: string, targetVirtualMcpId?: string) => {
    navigateThread(
      id,
      () => {
        const next: Record<string, unknown> = {};
        if (targetVirtualMcpId) next.virtualmcpid = targetVirtualMcpId;
        else Object.assign(next, preserveVirtualMcp);
        return next;
      },
      /** The target thread's agent moves the `{-$project}` segment with it. */
      { virtualMcpId: targetVirtualMcpId },
    );
  };

  const toggleMain = () => {
    const update = resolveWorkspacePanelAction(
      {
        type: "toggleMain",
        openMainValue: defaultTabId,
      },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
  };

  const toggleSidePanel = () => {
    const update = resolveWorkspacePanelAction(
      { type: "toggleSidePanel" },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
  };

  const setMobileSurface = (surface: MobileWorkspaceSurface) => {
    const activeMainTab =
      mainParam && mainParam !== "0" ? mainParam : defaultTabId;
    navigateSearch(mobileSurfaceSearch(surface, activeMainTab), {
      replace: true,
    });
  };

  const openSidePanel = () => {
    const update = resolveWorkspacePanelAction(
      { type: "openSidePanel" },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
  };

  // Inherit the branch of the thread the user is currently viewing, so a new
  // chat lands on the same sandbox/branch. Branchless / unknown → omit and let
  // the server pick the most-recently-touched branch from the user's sandboxMap.
  const createNewTask = async () => {
    const newTaskId = crypto.randomUUID();
    const branch = threads.find((t) => t.id === threadId)?.branch ?? null;
    try {
      await create({
        id: newTaskId,
        virtual_mcp_id: virtualMcpId,
        ...(branch ? { branch } : {}),
      });
    } catch {
      // Toast already fired by useCollectionActions; navigate anyway so the
      // route loader's ensure-fallback can retry.
    }
    // Omit `sidepanel` so the agent-configured default (resolveDefaultPanelState
    // — honors chatDefaultOpen / defaultMainView) drives whether the chat opens,
    // instead of forcing it open on an agent that opts out of the chat panel.
    navigateThread(newTaskId, () => ({ ...preserveVirtualMcp }));
  };

  const openTab = (id: string) => {
    navigateSearch({ main: id === "0" ? 0 : id }, { replace: true });
  };

  return {
    threadId,
    providerKey,
    sidePanelOpen,
    mainOpen,
    mainParam,
    sidePanelParamPresent: search.sidepanel !== undefined,
    setTaskId,
    toggleMain,
    toggleSidePanel,
    setMobileSurface,
    openSidePanel,
    createNewTask,
    openTab,
  };
}
