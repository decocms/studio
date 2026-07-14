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

export function resolveDefaultPanelState(ctx: {
  entityMetadata: EntityLayoutMetadata | null;
  mainParamPresent: boolean;
  mainParamValue?: string;
  blocksParamPresent: boolean;
  blocksParamValue?: number;
}): WorkspaceVisibility {
  const def = ctx.entityMetadata?.defaultMainView ?? null;
  const defaultIsChat = def == null || def.type === "chat";
  const defaultIsBlocks = def?.type === "blocks";
  const legacyBlocksOnly =
    !ctx.blocksParamPresent &&
    ctx.mainParamPresent &&
    ctx.mainParamValue === "blocks";

  const mainOpen = legacyBlocksOnly
    ? false
    : ctx.mainParamPresent
      ? ctx.mainParamValue !== "0"
      : !defaultIsChat && !defaultIsBlocks;

  // Chat is always open when it IS the default view. Otherwise it opens
  // alongside the main view only when the agent's layout opts in via
  // chatDefaultOpen.
  const chatOpen =
    legacyBlocksOnly || defaultIsBlocks
      ? false
      : defaultIsChat
        ? true
        : (ctx.entityMetadata?.chatDefaultOpen ?? false);
  const blocksOpen = legacyBlocksOnly
    ? true
    : parsePanelParam(
        ctx.blocksParamPresent ? ctx.blocksParamValue : undefined,
        defaultIsBlocks,
      );

  return withWorkspaceFallback({
    mainOpen,
    chatOpen,
    blocksOpen,
  });
}

export function computeChatMainSizes(
  chatOpen: boolean,
  mainOpen: boolean,
): { chat: number; main: number } {
  if (chatOpen && mainOpen) return { chat: 33, main: 67 };
  if (chatOpen && !mainOpen) return { chat: 100, main: 0 };
  if (!chatOpen && mainOpen) return { chat: 0, main: 100 };
  return { chat: 0, main: 0 };
}

// ---------------------------------------------------------------------------
// Search param helpers
// ---------------------------------------------------------------------------

type PanelSearchParams = {
  chat?: number;
  blocks?: number;
  main?: string;
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

  const defaults = resolveDefaultPanelState({
    entityMetadata,
    mainParamPresent: search.main !== undefined,
    mainParamValue: search.main,
    blocksParamPresent: search.blocks !== undefined,
    blocksParamValue: search.blocks,
  });

  const { chatOpen, blocksOpen, mainOpen } = withWorkspaceFallback({
    chatOpen: parsePanelParam(search.chat, defaults.chatOpen),
    blocksOpen: parsePanelParam(search.blocks, defaults.blocksOpen),
    mainOpen: defaults.mainOpen,
  });
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
    if (mainOpen) {
      if (!canCloseWorkspacePanel("main", visibility)) return;
      navigateSearch({ main: "0" }, { replace: true });
    } else {
      navigateSearch(
        { main: resolveDefaultTabId(entityMetadata) },
        { replace: true },
      );
    }
  };

  const toggleChat = () => {
    if (chatOpen && !canCloseWorkspacePanel("chat", visibility)) return;
    navigateSearch({ chat: chatOpen ? 0 : 1 }, { replace: true });
  };

  const toggleBlocks = () => {
    if (blocksOpen && !canCloseWorkspacePanel("blocks", visibility)) return;
    navigateSearch({ blocks: blocksOpen ? 0 : 1 }, { replace: true });
  };

  const openChat = () => {
    if (chatOpen) return;
    navigateSearch({ chat: 1 }, { replace: true });
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
    navigateSearch({ main: id }, { replace: true });
  };

  return {
    taskId,
    mainOpen,
    chatOpen,
    blocksOpen,
    mainParam: search.main,
    setTaskId,
    toggleMain,
    toggleChat,
    toggleBlocks,
    openChat,
    createNewTask,
    openTab,
  };
}
