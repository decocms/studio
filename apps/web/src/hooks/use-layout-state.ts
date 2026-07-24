/**
 * useWorkspaceLayoutState — Querystring-driven state for the shared side
 * panel and the tabbed main panel.
 *
 * URL model:
 *   ?sidepanel=chat         chat side panel open
 *   ?sidepanel=0            side panel closed
 *   ?sidepanel absent       agent-configured default
 *   ?main=<tabId>           main panel open, tab active
 *   ?main=0                 main panel closed
 *   ?main absent            agent-configured default
 *   ?virtualmcpid           which MCP the workspace is scoped to
 */

import { useRef } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { resolveDefaultTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useThreadActions, useThreads } from "@/components/chat/store/hooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SidePanelKind = "chat";

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
  taskId: string;
  sidePanel: SidePanelKind | null;
  mainOpen: boolean;
  /** Current ?main value (undefined when param absent). "0" = closed. */
  mainParam: string | undefined;
}

export interface WorkspaceLayoutActions {
  setTaskId: (id: string, virtualMcpId?: string) => void;
  toggleMain: () => void;
  toggleSidePanel: (sidePanel: SidePanelKind) => void;
  setMobileSurface: (surface: MobileWorkspaceSurface) => void;
  openSidePanel: (sidePanel: SidePanelKind) => void;
  createNewTask: () => void;
  openTab: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export type WorkspacePanel = "side" | "main";

export interface WorkspaceVisibility {
  sidePanel: SidePanelKind | null;
  mainOpen: boolean;
}

export type WorkspacePanelAction =
  | { type: "toggleSidePanel"; sidePanel: SidePanelKind }
  | { type: "toggleMain"; openMainValue: string }
  | { type: "openSidePanel"; sidePanel: SidePanelKind };

export type WorkspacePanelSearchUpdate = {
  sidepanel?: SidePanelKind | 0;
  main?: string | 0;
};

export function canCloseWorkspacePanel(
  panel: WorkspacePanel,
  visibility: WorkspaceVisibility,
): boolean {
  const openPanelCount =
    Number(visibility.sidePanel !== null) + Number(visibility.mainOpen);

  if (openPanelCount <= 1) return false;
  return panel === "side" ? visibility.sidePanel !== null : visibility.mainOpen;
}

function withWorkspaceFallback(
  visibility: WorkspaceVisibility,
): WorkspaceVisibility {
  if (visibility.sidePanel !== null || visibility.mainOpen) return visibility;
  return { ...visibility, sidePanel: "chat" };
}

export function resolveDefaultPanelState(ctx: {
  entityMetadata: EntityLayoutMetadata | null;
  mainParamPresent: boolean;
  mainParamValue?: string | 0;
  sidePanelParamPresent: boolean;
  sidePanelParamValue?: SidePanelKind | 0;
}): WorkspaceVisibility {
  const mainParamValue = ctx.mainParamValue === 0 ? "0" : ctx.mainParamValue;
  const defaultView = ctx.entityMetadata?.defaultMainView ?? null;
  const defaultIsChat = defaultView == null || defaultView.type === "chat";

  const mainOpen = ctx.mainParamPresent
    ? mainParamValue !== "0"
    : !defaultIsChat;
  const defaultSidePanel: SidePanelKind | null =
    defaultIsChat || ctx.entityMetadata?.chatDefaultOpen ? "chat" : null;
  const sidePanel = ctx.sidePanelParamPresent
    ? ctx.sidePanelParamValue === 0
      ? null
      : (ctx.sidePanelParamValue ?? null)
    : defaultSidePanel;

  return withWorkspaceFallback({ sidePanel, mainOpen });
}

export function resolveWorkspacePanelAction(
  action: WorkspacePanelAction,
  visibility: WorkspaceVisibility,
): WorkspacePanelSearchUpdate | null {
  switch (action.type) {
    case "toggleSidePanel":
      if (visibility.sidePanel === action.sidePanel) {
        if (!canCloseWorkspacePanel("side", visibility)) return null;
        return { sidepanel: 0 };
      }
      return { sidepanel: action.sidePanel };
    case "toggleMain":
      if (visibility.mainOpen) {
        if (!canCloseWorkspacePanel("main", visibility)) return null;
        return { main: 0 };
      }
      return { main: action.openMainValue };
    case "openSidePanel":
      return visibility.sidePanel === action.sidePanel
        ? null
        : { sidepanel: action.sidePanel };
  }
}

export interface WorkspacePanelSizes {
  side: number;
  main: number;
}

export function computeWorkspacePanelSizes(
  visibility: WorkspaceVisibility,
): WorkspacePanelSizes {
  if (visibility.sidePanel !== null && visibility.mainOpen) {
    return { side: 33, main: 67 };
  }
  if (visibility.sidePanel !== null) return { side: 100, main: 0 };
  if (visibility.mainOpen) return { side: 0, main: 100 };
  return { side: 0, main: 0 };
}

export type MobileWorkspaceSurface = SidePanelKind | "main";

export function mobileSurfaceSearch(
  surface: MobileWorkspaceSurface,
  mainTabId: string,
): Required<Pick<WorkspacePanelSearchUpdate, "sidepanel" | "main">> {
  if (surface === "main") return { sidepanel: 0, main: mainTabId };
  return { sidepanel: surface, main: 0 };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

type PanelSearchParams = {
  sidepanel?: SidePanelKind | 0;
  main?: string | 0;
  virtualmcpid?: string;
};

export interface WorkspaceLayoutStateRouteCtx {
  virtualMcpId: string;
  orgSlug: string;
  isAgentRoute: boolean;
}

export function useWorkspaceLayoutState(
  entityMetadata: EntityLayoutMetadata | null,
  routeCtx: WorkspaceLayoutStateRouteCtx,
): WorkspaceLayoutState & WorkspaceLayoutActions {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as PanelSearchParams;
  const routeParamsRaw = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const { create } = useThreadActions();
  const { threads } = useThreads();

  const { virtualMcpId, orgSlug, isAgentRoute } = routeCtx;
  const mainParam = search.main === 0 ? "0" : search.main;

  const { sidePanel, mainOpen } = resolveDefaultPanelState({
    entityMetadata,
    mainParamPresent: search.main !== undefined,
    mainParamValue: mainParam,
    sidePanelParamPresent: search.sidepanel !== undefined,
    sidePanelParamValue: search.sidepanel,
  });
  const visibility = { sidePanel, mainOpen };

  const fallbackRef = useRef(crypto.randomUUID());
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  const taskId = routeParamsRaw.taskId ?? fallbackRef.current;

  const routeBase = "/$org/$taskId" as const;
  const makeParams = (tid: string) => ({ org: orgSlug, taskId: tid });
  const preserveVirtualMcp = isAgentRoute ? { virtualmcpid: virtualMcpId } : {};

  const navigateSearch = (
    updates: Record<string, unknown>,
    options?: { replace?: boolean },
  ) => {
    navigate({
      to: routeBase,
      params: makeParams(taskId),
      search: (prev: Record<string, unknown>) => ({ ...prev, ...updates }),
      replace: options?.replace ?? false,
    });
  };

  const setTaskId = (id: string, targetVirtualMcpId?: string) => {
    navigate({
      to: routeBase,
      params: makeParams(id),
      search: (_prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = {};
        if (targetVirtualMcpId) next.virtualmcpid = targetVirtualMcpId;
        else if (isAgentRoute) next.virtualmcpid = virtualMcpId;
        return next;
      },
    });
  };

  const toggleMain = () => {
    const update = resolveWorkspacePanelAction(
      {
        type: "toggleMain",
        openMainValue: resolveDefaultTabId(entityMetadata),
      },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
  };

  const toggleSidePanel = (target: SidePanelKind) => {
    const update = resolveWorkspacePanelAction(
      { type: "toggleSidePanel", sidePanel: target },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
  };

  const setMobileSurface = (surface: MobileWorkspaceSurface) => {
    const activeMainTab =
      mainParam && mainParam !== "0"
        ? mainParam
        : resolveDefaultTabId(entityMetadata);
    navigateSearch(mobileSurfaceSearch(surface, activeMainTab), {
      replace: true,
    });
  };

  const openSidePanel = (target: SidePanelKind) => {
    const update = resolveWorkspacePanelAction(
      { type: "openSidePanel", sidePanel: target },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
  };

  // Inherit the branch of the thread the user is currently viewing, so a new
  // chat lands on the same sandbox/branch (not the shared default). Branchless /
  // unknown → omit and let the server assign the default.
  const createNewTask = async () => {
    const newTaskId = crypto.randomUUID();
    const branch = threads.find((t) => t.id === taskId)?.branch ?? null;
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
    navigate({
      to: routeBase,
      params: makeParams(newTaskId),
      search: (_prev: Record<string, unknown>) => ({
        ...preserveVirtualMcp,
        sidepanel: "chat" as const,
      }),
    });
  };

  const openTab = (id: string) => {
    navigateSearch({ main: id === "0" ? 0 : id }, { replace: true });
  };

  return {
    taskId,
    sidePanel,
    mainOpen,
    mainParam,
    setTaskId,
    toggleMain,
    toggleSidePanel,
    setMobileSurface,
    openSidePanel,
    createNewTask,
    openTab,
  };
}
