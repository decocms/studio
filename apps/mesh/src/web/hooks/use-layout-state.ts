/**
 * useChatMainPanelState — Querystring-driven panel layout state for the
 * side panel (chat / blocks) + main panel.
 *
 * The workspace is two panels: the side panel is *how you author* — you either
 * converse with the agent (chat) or edit blocks by hand — and the main panel is
 * *what you get*. Chat and Blocks are alternatives, not neighbours: Blocks is
 * itself a list plus a props editor, so giving it a third of a three-way split
 * left the editor unusably narrow.
 *
 * URL model — the two panels read the same way, `<panel>=<surface>|0`:
 *   ?main=<tabId>        main panel open, tab active
 *   ?main=0              main panel closed
 *   ?main absent         default (open for non-chat, non-blocks main views)
 *   ?sidepanel=chat|blocks   which surface the side panel shows
 *   ?sidepanel=0         side panel collapsed
 *   ?virtualmcpid        which MCP the chat + main panel are scoped to
 *
 * Legacy `?chat=0|1` / `?blocks=0|1` / `?main=blocks` links still resolve (see
 * resolveSidePanel); every write clears them so a stale param can't fight
 * `?sidepanel` on the next read.
 */

import { useRef } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { resolveDefaultTabId } from "@/web/layouts/main-panel-tabs/tab-id";
import { readCachedTaskBranch } from "@/web/lib/read-cached-task-branch";
import { useThreadActions } from "@/web/components/chat/store/hooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityLayoutMetadata {
  defaultMainView?: {
    type: string;
    id?: string;
    toolName?: string;
  } | null;
  /**
   * When true, the side panel opens on chat alongside the main view. Ignored
   * when defaultMainView is chat (chat is always the side surface then).
   */
  chatDefaultOpen?: boolean | null;
  tabs?: Array<{ id: string }>;
}

export interface ChatMainLayoutState extends WorkspaceVisibility {
  taskId: string;
  /** Current ?main value (undefined when param absent). "0" = closed. */
  mainParam: string | undefined;
}

export interface ChatMainLayoutActions {
  setTaskId: (id: string, virtualMcpId?: string) => void;
  toggleMain: () => void;
  selectSidePanel: (tab: SidePanelTab) => void;
  setMobileSurface: (surface: MobileWorkspaceSurface) => void;
  openChat: () => void;
  createNewTask: () => void;
  openTab: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** The two surfaces the side panel can show. */
export type SidePanelTab = "chat" | "blocks";

export interface WorkspaceVisibility {
  /** Which surface the side panel shows, or null while it is collapsed. */
  sidePanel: SidePanelTab | null;
  mainOpen: boolean;
}

export type WorkspacePanelAction =
  | { type: "selectSidePanel"; tab: SidePanelTab }
  | { type: "toggleMain"; openMainValue: string }
  | { type: "openChat" };

export type WorkspacePanelSearchUpdate = {
  sidepanel?: SidePanelTab | 0;
  main?: string | 0;
  /** Cleared alongside every `sidepanel` write so legacy links stop resolving. */
  chat?: undefined;
  blocks?: undefined;
};

/**
 * Search-param update that puts a surface into the side panel (or collapses it
 * with `0`). Writing `sidepanel` retires the legacy params that would otherwise
 * shadow it on the next read — anything navigating the side panel must go
 * through here rather than setting `chat` / `blocks` by hand.
 */
export function sidePanelSearch(
  sidepanel: SidePanelTab | 0,
): WorkspacePanelSearchUpdate {
  return { sidepanel, chat: undefined, blocks: undefined };
}

/**
 * A legacy `?main=blocks` link carried Blocks as the main view; keep it on
 * screen as the side surface now that a tab is taking over main.
 */
export function carryLegacyBlocksMainView(prev: {
  main?: unknown;
  sidepanel?: unknown;
}): WorkspacePanelSearchUpdate {
  return prev.main === "blocks" && prev.sidepanel === undefined
    ? sidePanelSearch("blocks")
    : {};
}

/**
 * Either panel may collapse only while the other is still on screen — one of
 * them has to be showing something.
 */
export function canCollapsePanel(visibility: WorkspaceVisibility): boolean {
  return visibility.sidePanel !== null && visibility.mainOpen;
}

function withWorkspaceFallback(
  visibility: WorkspaceVisibility,
): WorkspaceVisibility {
  if (visibility.sidePanel || visibility.mainOpen) return visibility;
  return { ...visibility, sidePanel: "chat" };
}

function parseSidePanelParam(value: string | 0): SidePanelTab {
  return value === "blocks" ? "blocks" : "chat";
}

/**
 * Resolve the side surface from the URL, falling back to the entity default.
 *
 * Legacy `?chat` / `?blocks` are read only when `?sidepanel` is absent. When
 * both legacy params ask to be open, blocks wins: it is the more specific
 * intent, and the pair was never a state any entity default produced.
 */
export function resolveSidePanel(
  defaultSidePanel: SidePanelTab | null,
  params: { sidepanel?: string | 0; chat?: number; blocks?: number },
): SidePanelTab | null {
  if (params.sidepanel !== undefined) {
    return params.sidepanel === 0 || params.sidepanel === "0"
      ? null
      : parseSidePanelParam(params.sidepanel);
  }
  if (params.blocks === 1) return "blocks";
  if (params.chat === 1) return "chat";
  if (params.blocks === 0 && defaultSidePanel === "blocks") return null;
  if (params.chat === 0 && defaultSidePanel === "chat") return null;
  return defaultSidePanel;
}

export function resolveWorkspaceVisibility(
  defaults: WorkspaceVisibility,
  params: { sidepanel?: string | 0; chat?: number; blocks?: number },
): WorkspaceVisibility {
  return withWorkspaceFallback({
    sidePanel: resolveSidePanel(defaults.sidePanel, params),
    mainOpen: defaults.mainOpen,
  });
}

export function resolveWorkspacePanelAction(
  action: WorkspacePanelAction,
  visibility: WorkspaceVisibility,
): WorkspacePanelSearchUpdate | null {
  switch (action.type) {
    case "selectSidePanel":
      // Re-selecting the active surface collapses the panel; a different
      // surface swaps into it rather than opening a second column.
      if (visibility.sidePanel !== action.tab) {
        return sidePanelSearch(action.tab);
      }
      return canCollapsePanel(visibility) ? sidePanelSearch(0) : null;
    case "toggleMain":
      if (visibility.mainOpen) {
        return canCollapsePanel(visibility) ? { main: 0 } : null;
      }
      return { main: action.openMainValue };
    case "openChat":
      return visibility.sidePanel === "chat" ? null : sidePanelSearch("chat");
  }
}

export function resolveDefaultPanelState(ctx: {
  entityMetadata: EntityLayoutMetadata | null;
  mainParamPresent: boolean;
  mainParamValue?: string | 0;
}): WorkspaceVisibility {
  const mainParamValue = ctx.mainParamValue === 0 ? "0" : ctx.mainParamValue;
  const def = ctx.entityMetadata?.defaultMainView ?? null;
  const defaultIsChat = def == null || def.type === "chat";
  const defaultIsBlocks = def?.type === "blocks";
  const legacyBlocksView = ctx.mainParamPresent && mainParamValue === "blocks";

  const mainOpen = legacyBlocksView
    ? false
    : ctx.mainParamPresent
      ? mainParamValue !== "0"
      : !defaultIsChat && !defaultIsBlocks;

  // Chat is the side surface when it IS the default view. Otherwise the side
  // panel opens on chat alongside the main view only when the agent's layout
  // opts in via chatDefaultOpen.
  const sidePanel: SidePanelTab | null =
    legacyBlocksView || defaultIsBlocks
      ? "blocks"
      : defaultIsChat
        ? "chat"
        : ctx.entityMetadata?.chatDefaultOpen
          ? "chat"
          : null;

  return withWorkspaceFallback({ sidePanel, mainOpen });
}

/**
 * Default width (percent) of the side panel per surface. Chat is a
 * conversation column; blocks is a fixed 240px list plus a props editor, so it
 * needs roughly half the workspace before the editor is usable.
 */
export const DEFAULT_SIDE_PANEL_WIDTH: Record<SidePanelTab, number> = {
  chat: 33,
  blocks: 50,
};

export interface WorkspacePanelSizes {
  sidePanel: number;
  main: number;
}

export function computeWorkspacePanelSizes(
  visibility: WorkspaceVisibility,
): WorkspacePanelSizes {
  if (!visibility.sidePanel) return { sidePanel: 0, main: 100 };
  if (!visibility.mainOpen) return { sidePanel: 100, main: 0 };
  const sidePanel = DEFAULT_SIDE_PANEL_WIDTH[visibility.sidePanel];
  return { sidePanel, main: 100 - sidePanel };
}

export type MobileWorkspaceSurface = "chat" | "blocks" | "main";

export function mobileSurfaceSearch(
  surface: MobileWorkspaceSurface,
  mainTabId: string,
): WorkspacePanelSearchUpdate {
  if (surface === "main") return { ...sidePanelSearch(0), main: mainTabId };
  return { ...sidePanelSearch(surface), main: 0 };
}

/** Which single surface a mobile viewport shows for a given layout state. */
export function resolveMobileSurface(
  visibility: WorkspaceVisibility,
): MobileWorkspaceSurface {
  if (visibility.sidePanel === "blocks") return "blocks";
  return visibility.mainOpen ? "main" : "chat";
}

// ---------------------------------------------------------------------------
// Search param helpers
// ---------------------------------------------------------------------------

type PanelSearchParams = {
  sidepanel?: SidePanelTab | 0;
  chat?: number;
  blocks?: number;
  main?: string | 0;
  virtualmcpid?: string;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface ChatMainPanelStateRouteCtx {
  virtualMcpId: string;
  orgSlug: string;
  isAgentRoute: boolean;
}

export function useChatMainPanelState(
  entityMetadata: EntityLayoutMetadata | null,
  routeCtx: ChatMainPanelStateRouteCtx,
): ChatMainLayoutState & ChatMainLayoutActions {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as PanelSearchParams;
  const routeParamsRaw = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const { create } = useThreadActions();
  const { locator } = useProjectContext();

  const { virtualMcpId, orgSlug, isAgentRoute } = routeCtx;
  const mainParam = search.main === 0 ? "0" : search.main;

  const defaults = resolveDefaultPanelState({
    entityMetadata,
    mainParamPresent: search.main !== undefined,
    mainParamValue: mainParam,
  });

  const visibility = resolveWorkspaceVisibility(defaults, search);
  const { sidePanel, mainOpen } = visibility;

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

  const applyAction = (action: WorkspacePanelAction) => {
    const update = resolveWorkspacePanelAction(action, visibility);
    if (update) navigateSearch(update, { replace: true });
  };

  const toggleMain = () =>
    applyAction({
      type: "toggleMain",
      openMainValue: resolveDefaultTabId(entityMetadata),
    });

  const selectSidePanel = (tab: SidePanelTab) =>
    applyAction({ type: "selectSidePanel", tab });

  const openChat = () => applyAction({ type: "openChat" });

  const setMobileSurface = (surface: MobileWorkspaceSurface) => {
    const activeMainTab =
      mainParam && mainParam !== "0" && mainParam !== "blocks"
        ? mainParam
        : resolveDefaultTabId(entityMetadata);
    navigateSearch(mobileSurfaceSearch(surface, activeMainTab), {
      replace: true,
    });
  };

  // Carry the active task's branch into the new thread so it lands on the
  // same warm sandbox. Server picks from sandboxMap when no branch is provided.
  const createNewTask = async () => {
    const newTaskId = crypto.randomUUID();
    const branch = readCachedTaskBranch(orgSlug, locator, taskId);
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
      search: (_prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = {
          ...preserveVirtualMcp,
          sidepanel: "chat",
        };
        return next;
      },
    });
  };

  const openTab = (id: string) => {
    navigateSearch(
      {
        ...carryLegacyBlocksMainView({
          main: mainParam,
          sidepanel: search.sidepanel,
        }),
        main: id === "0" ? 0 : id,
      },
      { replace: true },
    );
  };

  return {
    taskId,
    sidePanel,
    mainOpen,
    mainParam,
    setTaskId,
    toggleMain,
    selectSidePanel,
    setMobileSurface,
    openChat,
    createNewTask,
    openTab,
  };
}
