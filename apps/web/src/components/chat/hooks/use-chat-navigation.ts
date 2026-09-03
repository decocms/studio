import { useNavigate, useSearch } from "@tanstack/react-router";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";
import { isPerThreadTab } from "@/layouts/main-panel-tabs/tab-id";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import {
  canonicalThreadRouteTarget,
  navigateToTabRouteTarget,
  tabRouteLocation,
} from "@/layouts/main-panel-tabs/tab-route";
import { useRouteThreadId, useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AUTOSEND_QUERY_VALUE } from "@/lib/autosend";

export interface ChatNavigation {
  /** The agent this chat dispatches to: the route's, via {@link useRouteVirtualMcpId}. */
  virtualMcpId: string;
  /** The thread the matched route names, or `null` where it names none. */
  taskId: string | null;
  /** Navigate to a task in its agent-owned route. `autosend` tells the route to
   * consume the stored handoff message. */
  navigateToTask: (
    taskId: string,
    opts?: { virtualMcpId?: string; autosend?: boolean },
  ) => void;
}

export function useChatNavigation(): ChatNavigation {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  /**
   * The legacy route's `$taskId` path param or a destination's `?thread=`.
   * Neither exists on a route that names no thread, and inventing one there is
   * what used to make the workspace stream a thread that does not exist.
   */
  const taskId = useRouteThreadId();

  /**
   * The same route-aware answer the shell and breadcrumb use: `$agentId` wins,
   * legacy thread search is accepted only by its compatibility route, and org
   * pages fall back to Decopilot.
   */
  const virtualMcpId = useRouteVirtualMcpId();
  const activeTabId = useActivePanelTabId();
  const search = useSearch({ strict: false }) as { sidepanel?: boolean };

  const navigateToTask = (
    taskId: string,
    opts?: { virtualMcpId?: string; autosend?: boolean },
  ) => {
    /** A view that belongs to the thread being left does not follow it; a
     *  system view does, by navigating to its canonical route. */
    const carried =
      activeTabId && !isPerThreadTab(activeTabId) ? activeTabId : undefined;
    /** Org destinations cannot encode an agent. A thread opened from one moves
     * to its agent overview; agent-owned views carry forward as themselves. */
    const targetAgentId = opts?.virtualMcpId ?? virtualMcpId;
    const tabId =
      targetAgentId === virtualMcpId &&
      carried &&
      tabRouteLocation(carried).kind !== "org-destination"
        ? carried
        : "overview";
    const target = canonicalThreadRouteTarget({
      org: org.slug,
      agentId: targetAgentId,
      superAgentId: getWellKnownDecopilotVirtualMCP(org.id).id,
      tabId,
    });
    navigateToTabRouteTarget(navigate, target, {
      search: () => ({
        thread: taskId,
        ...(typeof search.sidepanel === "boolean"
          ? { sidepanel: search.sidepanel }
          : {}),
        ...(opts?.autosend ? { autosend: AUTOSEND_QUERY_VALUE } : {}),
      }),
      replace: false,
    });
  };

  return { virtualMcpId, taskId, navigateToTask };
}
