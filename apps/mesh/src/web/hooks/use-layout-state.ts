/**
 * useChatMainPanelState — Querystring-driven panel layout state for the
 * chat + main panels.
 *
 * URL model:
 *   ?main=<tabId>    main panel open, tab active
 *   ?main=0          main panel closed
 *   ?main absent     default (open iff defaultMainView != null)
 *   ?chat=0|1        chat panel open state
 *   ?virtualmcpid    which MCP the chat + right panel are scoped to
 *
 * Tasks-panel state is owned by useTasksPanelState (separate hook).
 */

import { useRef } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { resolveDefaultTabId } from "@/web/layouts/main-panel-tabs/tab-id";
import { readCachedTaskBranch } from "@/web/lib/read-cached-task-branch";
import { useTaskActions } from "@/web/hooks/use-tasks";

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
  /** Current ?main value (undefined when param absent). "0" = closed. */
  mainParam: string | undefined;
}

export interface ChatMainLayoutActions {
  setTaskId: (id: string, virtualMcpId?: string) => void;
  toggleMain: () => void;
  toggleChat: () => void;
  openChat: () => void;
  createNewTask: () => void;
  openTab: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export function resolveTasksOpen(
  urlParam: number | undefined,
  hasItems: boolean,
): boolean {
  if (urlParam === 1) return true;
  if (urlParam === 0) return false;
  return hasItems;
}

export function resolveDefaultPanelState(ctx: {
  entityMetadata: EntityLayoutMetadata | null;
  mainParamPresent: boolean;
  mainParamValue?: string;
}): { mainOpen: boolean; chatOpen: boolean } {
  const def = ctx.entityMetadata?.defaultMainView ?? null;
  const defaultIsChat = def == null || def.type === "chat";

  const mainOpen = ctx.mainParamPresent
    ? ctx.mainParamValue !== "0"
    : !defaultIsChat;

  // Chat is always open when it IS the default view. Otherwise it opens
  // alongside the main view only when the agent's layout opts in via
  // chatDefaultOpen.
  const chatOpen = defaultIsChat
    ? true
    : (ctx.entityMetadata?.chatDefaultOpen ?? false);

  return {
    mainOpen,
    chatOpen,
  };
}

export function computeChatMainSizes(
  chatOpen: boolean,
  mainOpen: boolean,
): { chat: number; main: number } {
  if (chatOpen && mainOpen) return { chat: 45, main: 55 };
  if (chatOpen && !mainOpen) return { chat: 100, main: 0 };
  if (!chatOpen && mainOpen) return { chat: 0, main: 100 };
  return { chat: 0, main: 0 };
}

// ---------------------------------------------------------------------------
// Search param helpers
// ---------------------------------------------------------------------------

type PanelSearchParams = {
  tasks?: number;
  chat?: number;
  main?: string;
  virtualmcpid?: string;
};

function parsePanelParam(
  value: number | undefined,
  defaultOpen: boolean,
): boolean {
  if (value === 1) return true;
  if (value === 0) return false;
  return defaultOpen;
}

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
  const queryClient = useQueryClient();
  const taskActions = useTaskActions();
  const { locator } = useProjectContext();

  const { virtualMcpId, orgSlug, isAgentRoute } = routeCtx;

  const defaults = resolveDefaultPanelState({
    entityMetadata,
    mainParamPresent: search.main !== undefined,
    mainParamValue: search.main,
  });

  const chatOpen = parsePanelParam(search.chat, defaults.chatOpen);
  const mainOpen = defaults.mainOpen;

  const fallbackRef = useRef(crypto.randomUUID());
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
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = {};
        if (targetVirtualMcpId) next.virtualmcpid = targetVirtualMcpId;
        else if (isAgentRoute) next.virtualmcpid = virtualMcpId;
        if (prev.tasks) next.tasks = prev.tasks;
        return next;
      },
    });
  };

  const toggleMain = () => {
    if (mainOpen) {
      navigateSearch({ main: "0" }, { replace: true });
    } else {
      navigateSearch(
        { main: resolveDefaultTabId(entityMetadata) },
        { replace: true },
      );
    }
  };

  const toggleChat = () => {
    navigateSearch({ chat: chatOpen ? 0 : 1 }, { replace: true });
  };

  const openChat = () => {
    if (chatOpen) return;
    navigateSearch({ chat: 1 }, { replace: true });
  };

  // Carry the active task's branch into the new thread so it lands on the
  // same warm sandbox. Server picks from vmMap when no branch is provided.
  const createNewTask = async () => {
    const newTaskId = crypto.randomUUID();
    const branch = readCachedTaskBranch(queryClient, locator, taskId);
    try {
      await taskActions.create.mutateAsync({
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
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = {
          ...preserveVirtualMcp,
          chat: 1,
        };
        if (prev.tasks) next.tasks = prev.tasks;
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
    mainParam: search.main,
    setTaskId,
    toggleMain,
    toggleChat,
    openChat,
    createNewTask,
    openTab,
  };
}
