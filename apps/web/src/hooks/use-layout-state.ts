/**
 * useWorkspaceLayoutState — URL-driven state for the shared side panel and the
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
 * WHICH view the main panel shows is the matched child route, not search — see
 * `main-panel-tabs/tab-route.ts`. Panel visibility actions navigate `to: "."`
 * and never touch the path, which means a closed panel still remembers its view
 * and can never fabricate a thread id. Hiding the main panel opens chat when
 * needed so the workspace always has a visible panel.
 * Thread-changing actions go through `useThreadNavigate`, which writes the
 * canonical route's `?thread=` layout state. The legacy `/$org/$taskId` shape
 * is accepted only long enough for its compatibility redirect to settle.
 */

import { useRef } from "react";
import { useRouteThreadId, useThreadNavigate } from "@/layouts/thread-route";
import { useThreadActions, useThreads } from "@/components/chat/store/hooks";
import { threadHasMessages } from "@/lib/thread-has-messages";
import {
  resolveWorkspaceThread,
  type EntityLayoutMetadata,
  type WorkspaceLayoutActions,
  type WorkspaceLayoutState,
} from "./workspace-panel-state";
import {
  useWorkspacePanels,
  usePublishWorkspacePanelDefaults,
} from "@/layouts/workspace-panels-context";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWorkspaceLayoutState(
  entityMetadata: EntityLayoutMetadata | null,
  virtualMcpId: string,
): WorkspaceLayoutState & WorkspaceLayoutActions {
  const navigateThread = useThreadNavigate();
  const { create } = useThreadActions();
  const { threads } = useThreads();

  const panels = useWorkspacePanels();

  const routeThreadId = useRouteThreadId();
  const fallbackRef = useRef(crypto.randomUUID());
  const { threadId, providerKey } = resolveWorkspaceThread({
    routeThreadId,
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    fallbackKey: fallbackRef.current,
  });

  // Reopen the chat for a thread that already holds a conversation (threadHasMessages).
  const currentThread =
    threadId != null ? threads.find((t) => t.id === threadId) : undefined;

  usePublishWorkspacePanelDefaults({
    entityMetadata,
    threadHasMessages: currentThread ? threadHasMessages(currentThread) : false,
  });

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
    navigateThread(newTaskId, () => ({}));
  };

  return {
    threadId,
    providerKey,
    sidePanelOpen: panels.sidePanelOpen,
    mainOpen: panels.mainOpen,
    sidePanelParamPresent: panels.sidePanelParamPresent,
    toggleMain: panels.toggleMain,
    toggleSidePanel: panels.toggleSidePanel,
    createNewTask,
  };
}
