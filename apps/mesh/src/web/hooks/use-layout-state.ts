/**
 * useLayoutState — Querystring-driven panel layout state.
 *
 * Panel open/closed state lives in URL search params.
 * Panel widths stay in localStorage.
 * Runtime toggles use imperative panel refs for smooth animation.
 * ResizablePanelGroup key changes only on agent switch.
 *
 * All panel-state writes use navigate({ replace: true }) to avoid history pollution.
 */

import { useRef } from "react";
import { useMatch, useNavigate, useSearch } from "@tanstack/react-router";
import {
  getDecopilotId,
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityLayoutMetadata {
  defaultMainView?: { type: string } | null;
  chatDefaultOpen?: boolean | null;
}

export interface LayoutState {
  taskId: string;
  tasksOpen: boolean;
  mainOpen: boolean;
  chatOpen: boolean;
  mainView: string | undefined;
  mainViewId: string | undefined;
  toolName: string | undefined;
}

export interface LayoutActions {
  setTaskId: (id: string) => void;
  toggleTasks: () => void;
  toggleMain: () => void;
  toggleChat: () => void;
  openChat: () => void;
  createNewTask: () => void;
  openMainView: (
    view: string,
    opts?: { id?: string; toolName?: string },
  ) => void;
  closeMainView: () => void;
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Determines whether a toggle action is allowed.
 * Returns false if toggling the panel off would leave zero panels open.
 */
export function canToggle(
  panelIsOpen: boolean,
  expandedCount: number,
): boolean {
  if (panelIsOpen && expandedCount <= 1) return false;
  return true;
}

/**
 * Resolves default panel open/closed state when URL params are absent.
 *
 * Rules:
 * 1. Non-agent-home routes: all panels expanded
 * 2. Agent home with ?main param: all panels expanded
 * 3. Agent home, decopilot ID: tasks closed, main closed, chat open
 * 4. Agent home, entity default view is chat/null: main collapsed, chat open
 * 5. Agent home, entity default view is non-chat: main open, chat uses chatDefaultOpen
 */
export function resolveDefaultPanelState(ctx: {
  virtualMcpId: string;
  orgId: string;
  entityMetadata: EntityLayoutMetadata | null;
  hasMainParam: boolean;
  isAgentHomeRoute: boolean;
}): { tasksOpen: boolean; mainOpen: boolean; chatOpen: boolean } {
  const allOpen = { tasksOpen: true, mainOpen: true, chatOpen: true };

  // Non-agent-home routes: all expanded
  if (!ctx.isAgentHomeRoute) {
    return allOpen;
  }

  // ?main param present: all expanded
  if (ctx.hasMainParam) {
    return allOpen;
  }

  // Decopilot ID: tasks closed, main closed, chat open
  const isDecopilot = ctx.virtualMcpId === getDecopilotId(ctx.orgId);
  if (isDecopilot) {
    return { tasksOpen: false, mainOpen: false, chatOpen: true };
  }

  // Entity metadata driven defaults
  const defaultViewType = ctx.entityMetadata?.defaultMainView?.type ?? null;
  const showMain =
    defaultViewType === "automation" ||
    defaultViewType === "ext-apps" ||
    defaultViewType === "settings";

  if (!showMain) {
    // Default view is chat or unset — chat visible, main collapsed
    return { tasksOpen: true, mainOpen: false, chatOpen: true };
  }

  // Non-chat default view — respect chatDefaultOpen config
  const chatDefaultOpen = ctx.entityMetadata?.chatDefaultOpen ?? false;
  return { tasksOpen: true, mainOpen: true, chatOpen: chatDefaultOpen };
}

/**
 * Maps panel open/closed booleans to default size percentages.
 */
export function computeDefaultSizes(state: {
  tasksOpen: boolean;
  mainOpen: boolean;
  chatOpen: boolean;
}): { tasks: number; main: number; chat: number } {
  const { tasksOpen, mainOpen, chatOpen } = state;

  if (tasksOpen && mainOpen && chatOpen)
    return { tasks: 20, main: 45, chat: 35 };
  if (!tasksOpen && mainOpen && chatOpen)
    return { tasks: 0, main: 65, chat: 35 };
  if (tasksOpen && !mainOpen && chatOpen)
    return { tasks: 20, main: 0, chat: 80 };
  if (tasksOpen && mainOpen && !chatOpen)
    return { tasks: 20, main: 80, chat: 0 };
  if (!tasksOpen && !mainOpen && chatOpen)
    return { tasks: 0, main: 0, chat: 100 };
  if (!tasksOpen && mainOpen && !chatOpen)
    return { tasks: 0, main: 100, chat: 0 };
  if (tasksOpen && !mainOpen && !chatOpen)
    return { tasks: 100, main: 0, chat: 0 };

  // Fallback (all closed — shouldn't happen due to toggle guard)
  return { tasks: 0, main: 0, chat: 100 };
}

// ---------------------------------------------------------------------------
// Search param helpers
// ---------------------------------------------------------------------------

type PanelSearchParams = {
  taskId?: string;
  tasks?: number;
  mainOpen?: number;
  chat?: number;
  main?: string;
  id?: string;
  toolName?: string;
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

export function useLayoutState(): LayoutState & LayoutActions {
  const navigate = useNavigate();
  const { org } = useProjectContext();

  const search = useSearch({ strict: false }) as PanelSearchParams;

  const agentsMatch = useMatch({
    from: "/shell/$org/$virtualMcpId",
    shouldThrow: false,
  });
  const orgHomeMatch = useMatch({
    from: "/shell/$org/",
    shouldThrow: false,
  });
  const agentHomeMatch = useMatch({
    from: "/shell/$org/$virtualMcpId/",
    shouldThrow: false,
  });

  // Resolve virtualMcpId: agent route param or decopilot fallback
  const virtualMcpId =
    agentsMatch?.params.virtualMcpId ??
    getWellKnownDecopilotVirtualMCP(org.id).id;

  const isAgentRoute = !!agentsMatch;
  const isOrgHome = !!orgHomeMatch && !agentsMatch;
  // Org home is effectively the decopilot agent's home route
  const isAgentHomeRoute = (isAgentRoute && !!agentHomeMatch) || isOrgHome;

  // Resolve defaults (entity metadata is not available here — it's inside
  // VirtualMCPProvider's Suspense boundary. We pass null for entityMetadata
  // and let the Suspense-resolved component override via the URL on mount.)
  const defaults = resolveDefaultPanelState({
    virtualMcpId,
    orgId: org.id,
    entityMetadata: null,
    hasMainParam: !!search.main,
    isAgentHomeRoute,
  });

  // Parse panel state from URL, falling back to defaults
  const tasksOpen = parsePanelParam(search.tasks, defaults.tasksOpen);
  const mainOpen = parsePanelParam(search.mainOpen, defaults.mainOpen);
  const chatOpen = parsePanelParam(search.chat, defaults.chatOpen);

  // taskId fallback for non-validated routes
  const fallbackRef = useRef(crypto.randomUUID());
  const taskId = search.taskId ?? fallbackRef.current;

  // Expanded count for toggle guard
  const expandedCount = [tasksOpen, mainOpen, chatOpen].filter(Boolean).length;

  // --- Route params for navigation ---
  const orgSlug =
    agentsMatch?.params.org ?? orgHomeMatch?.params.org ?? org.slug;
  const routeBase = isAgentRoute
    ? ("/$org/$virtualMcpId/" as const)
    : ("/$org/" as const);
  const routeParams = isAgentRoute
    ? { org: orgSlug, virtualMcpId }
    : { org: orgSlug };

  // Helper: navigate with search params (replace for panel state)
  const navigateSearch = (
    updates: Record<string, unknown>,
    options?: { replace?: boolean },
  ) => {
    navigate({
      to: routeBase,
      params: routeParams,
      search: (prev: Record<string, unknown>) => ({ ...prev, ...updates }),
      replace: options?.replace ?? false,
    });
  };

  // --- Actions ---
  // Toggle actions only update the URL. The ResizablePanelGroup remounts via
  // key={virtualMcpId}-${tasksOpen}-${mainOpen}-${chatOpen}, which applies
  // the correct deterministic sizes from computeDefaultSizes().

  const setTaskId = (id: string) => {
    // Reset all panel state — only preserve taskId + tasks panel
    navigate({
      to: routeBase,
      params: routeParams,
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { taskId: id };
        if (prev.tasks) next.tasks = prev.tasks;
        return next;
      },
    });
  };

  const toggleTasks = () => {
    if (!canToggle(tasksOpen, expandedCount)) return;
    navigateSearch({ tasks: !tasksOpen ? 1 : 0 }, { replace: true });
  };

  const toggleMain = () => {
    if (!canToggle(mainOpen, expandedCount)) return;
    navigateSearch({ mainOpen: !mainOpen ? 1 : 0 }, { replace: true });
  };

  const toggleChat = () => {
    if (!canToggle(chatOpen, expandedCount)) return;
    navigateSearch({ chat: !chatOpen ? 1 : 0 }, { replace: true });
  };

  const openChat = () => {
    if (chatOpen) return;
    navigateSearch({ chat: 1 }, { replace: true });
  };

  const createNewTask = () => {
    const newTaskId = crypto.randomUUID();
    // Reset all panel state — only preserve tasks panel + force chat open
    navigate({
      to: routeBase,
      params: routeParams,
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = {
          taskId: newTaskId,
          chat: 1,
        };
        if (prev.tasks) next.tasks = prev.tasks;
        return next;
      },
    });
  };

  const openMainView = (
    view: string,
    opts?: { id?: string; toolName?: string },
  ) => {
    if (view === "default") {
      // Reset main view — clear main/id/toolName, preserve taskId and panel state
      navigate({
        to: routeBase,
        params: routeParams,
        search: (prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = {};
          if (prev.taskId) next.taskId = prev.taskId;
          if (prev.tasks) next.tasks = prev.tasks;
          if (prev.mainOpen) next.mainOpen = prev.mainOpen;
          if (prev.chat) next.chat = prev.chat;
          return next;
        },
        replace: true,
      });
      return;
    }

    const updates: Record<string, unknown> = {
      main: view,
      mainOpen: 1,
    };
    if (opts?.id) updates.id = opts.id;
    if (opts?.toolName) updates.toolName = opts.toolName;
    navigateSearch(updates, { replace: true });
  };

  const closeMainView = () => {
    navigate({
      to: routeBase,
      params: routeParams,
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = {};
        if (prev.taskId) next.taskId = prev.taskId;
        if (prev.tasks) next.tasks = prev.tasks;
        if (prev.chat) next.chat = prev.chat;
        next.mainOpen = 0;
        return next;
      },
      replace: true,
    });
  };

  return {
    taskId,
    tasksOpen,
    mainOpen,
    chatOpen,
    mainView: search.main,
    mainViewId: search.id,
    toolName: search.toolName,
    setTaskId,
    toggleTasks,
    toggleMain,
    toggleChat,
    openChat,
    createNewTask,
    openMainView,
    closeMainView,
  };
}
