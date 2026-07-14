/**
 * useChatMainPanelState — Querystring-driven panel layout state for the
 * chat + blocks + main panels.
 *
 * URL model:
 *   ?main=<tabId>    main panel open, tab active
 *   ?main=0          main panel closed
 *   ?main absent     default (open for non-chat, non-blocks main views)
 *   ?chat=0|1        chat panel open state
 *   ?blocks=0|1      blocks panel open state
 *   ?virtualmcpid    which MCP the chat + right panel are scoped to
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
   * When true, the chat panel is open alongside the main view. Ignored
   * when defaultMainView is chat (chat is always open in that case).
   */
  chatDefaultOpen?: boolean | null;
  tabs?: Array<{ id: string }>;
}

export interface ChatMainLayoutState {
  taskId: string;
  mainOpen: boolean;
  chatOpen: boolean;
  blocksOpen: boolean;
  /** Current ?main value (undefined when param absent). "0" = closed. */
  mainParam: string | undefined;
}

export interface ChatMainLayoutActions {
  setTaskId: (id: string, virtualMcpId?: string) => void;
  toggleMain: () => void;
  toggleChat: () => void;
  toggleBlocks: () => void;
  setMobileSurface: (surface: MobileWorkspaceSurface) => void;
  openChat: () => void;
  createNewTask: () => void;
  openTab: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export type WorkspacePanel = "chat" | "blocks" | "main";

export interface WorkspaceVisibility {
  chatOpen: boolean;
  blocksOpen: boolean;
  mainOpen: boolean;
}

export type WorkspacePanelAction =
  | { type: "toggleChat" }
  | { type: "toggleBlocks" }
  | { type: "toggleMain"; openMainValue: string }
  | { type: "openChat" };

export type WorkspacePanelSearchUpdate = {
  chat?: 0 | 1;
  blocks?: 0 | 1;
  main?: string | 0;
};

export function canCloseWorkspacePanel(
  panel: WorkspacePanel,
  visibility: WorkspaceVisibility,
): boolean {
  const openPanelCount =
    Number(visibility.chatOpen) +
    Number(visibility.blocksOpen) +
    Number(visibility.mainOpen);

  if (openPanelCount <= 1) return false;

  switch (panel) {
    case "chat":
      return visibility.chatOpen;
    case "blocks":
      return visibility.blocksOpen;
    case "main":
      return visibility.mainOpen;
  }
}

function withWorkspaceFallback(
  visibility: WorkspaceVisibility,
): WorkspaceVisibility {
  if (visibility.chatOpen || visibility.blocksOpen || visibility.mainOpen) {
    return visibility;
  }

  return { ...visibility, chatOpen: true };
}

function parsePanelParam(
  value: number | undefined,
  defaultOpen: boolean,
): boolean {
  if (value === 1) return true;
  if (value === 0) return false;
  return defaultOpen;
}

export function resolveWorkspaceVisibility(
  defaults: WorkspaceVisibility,
  params: { chat?: number; blocks?: number },
): WorkspaceVisibility {
  return withWorkspaceFallback({
    chatOpen: parsePanelParam(params.chat, defaults.chatOpen),
    blocksOpen: parsePanelParam(params.blocks, defaults.blocksOpen),
    mainOpen: defaults.mainOpen,
  });
}

export function resolveWorkspacePanelAction(
  action: WorkspacePanelAction,
  visibility: WorkspaceVisibility,
): WorkspacePanelSearchUpdate | null {
  switch (action.type) {
    case "toggleChat":
      if (visibility.chatOpen && !canCloseWorkspacePanel("chat", visibility)) {
        return null;
      }
      return { chat: visibility.chatOpen ? 0 : 1 };
    case "toggleBlocks":
      if (
        visibility.blocksOpen &&
        !canCloseWorkspacePanel("blocks", visibility)
      ) {
        return null;
      }
      return { blocks: visibility.blocksOpen ? 0 : 1 };
    case "toggleMain":
      if (visibility.mainOpen) {
        if (!canCloseWorkspacePanel("main", visibility)) return null;
        return { main: 0 };
      }
      return { main: action.openMainValue };
    case "openChat":
      return visibility.chatOpen ? null : { chat: 1 };
  }
}

export function resolveDefaultPanelState(ctx: {
  entityMetadata: EntityLayoutMetadata | null;
  mainParamPresent: boolean;
  mainParamValue?: string | 0;
  blocksParamPresent: boolean;
  blocksParamValue?: number;
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

  // Chat is always open when it IS the default view. Otherwise it opens
  // alongside the main view only when the agent's layout opts in via
  // chatDefaultOpen.
  const chatOpen =
    legacyBlocksView || defaultIsBlocks
      ? false
      : defaultIsChat
        ? true
        : (ctx.entityMetadata?.chatDefaultOpen ?? false);
  const blocksOpen = parsePanelParam(
    ctx.blocksParamPresent ? ctx.blocksParamValue : undefined,
    legacyBlocksView || defaultIsBlocks,
  );

  return withWorkspaceFallback({
    mainOpen,
    chatOpen,
    blocksOpen,
  });
}

export interface WorkspacePanelSizes {
  chat: number;
  blocks: number;
  main: number;
}

export function computeWorkspacePanelSizes(
  visibility: WorkspaceVisibility,
): WorkspacePanelSizes {
  const { chatOpen, blocksOpen, mainOpen } = visibility;
  if (chatOpen && blocksOpen && mainOpen) {
    return { chat: 25, blocks: 35, main: 40 };
  }
  if (chatOpen && blocksOpen) return { chat: 40, blocks: 60, main: 0 };
  if (chatOpen && mainOpen) return { chat: 33, blocks: 0, main: 67 };
  if (blocksOpen && mainOpen) return { chat: 0, blocks: 40, main: 60 };
  if (chatOpen) return { chat: 100, blocks: 0, main: 0 };
  if (blocksOpen) return { chat: 0, blocks: 100, main: 0 };
  if (mainOpen) return { chat: 0, blocks: 0, main: 100 };
  return { chat: 0, blocks: 0, main: 0 };
}

export type MobileWorkspaceSurface = "chat" | "blocks" | "main";

export function mobileSurfaceSearch(
  surface: MobileWorkspaceSurface,
  mainTabId: string,
): Required<Pick<WorkspacePanelSearchUpdate, "chat" | "blocks" | "main">> {
  switch (surface) {
    case "chat":
      return { chat: 1, blocks: 0, main: 0 };
    case "blocks":
      return { chat: 0, blocks: 1, main: 0 };
    case "main":
      return { chat: 0, blocks: 0, main: mainTabId };
  }
}

// ---------------------------------------------------------------------------
// Search param helpers
// ---------------------------------------------------------------------------

type PanelSearchParams = {
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
    blocksParamPresent: search.blocks !== undefined,
    blocksParamValue: search.blocks,
  });

  const { chatOpen, blocksOpen, mainOpen } = resolveWorkspaceVisibility(
    defaults,
    search,
  );
  const visibility = { chatOpen, blocksOpen, mainOpen };

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

  const toggleChat = () => {
    const update = resolveWorkspacePanelAction(
      { type: "toggleChat" },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
  };

  const toggleBlocks = () => {
    const update = resolveWorkspacePanelAction(
      { type: "toggleBlocks" },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
  };

  const setMobileSurface = (surface: MobileWorkspaceSurface) => {
    const activeMainTab =
      mainParam && mainParam !== "0" && mainParam !== "blocks"
        ? mainParam
        : resolveDefaultTabId(entityMetadata);
    navigateSearch(mobileSurfaceSearch(surface, activeMainTab), {
      replace: true,
    });
  };

  const openChat = () => {
    const update = resolveWorkspacePanelAction(
      { type: "openChat" },
      visibility,
    );
    if (update) navigateSearch(update, { replace: true });
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
          chat: 1,
        };
        return next;
      },
    });
  };

  const openTab = (id: string) => {
    navigateSearch(
      {
        ...(mainParam === "blocks" && search.blocks === undefined
          ? { blocks: 1 }
          : {}),
        main: id === "0" ? 0 : id,
      },
      { replace: true },
    );
  };

  return {
    taskId,
    mainOpen,
    chatOpen,
    blocksOpen,
    mainParam,
    setTaskId,
    toggleMain,
    toggleChat,
    toggleBlocks,
    setMobileSurface,
    openChat,
    createNewTask,
    openTab,
  };
}
