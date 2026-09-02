import { useNavigate, useSearch } from "@tanstack/react-router";
import { useProjectContext } from "@/sdk";
import { isPerThreadTab } from "@/layouts/main-panel-tabs/tab-id";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import { panelLocationForTab } from "@/layouts/main-panel-tabs/panel-route";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useRouteThreadId, useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AUTOSEND_QUERY_VALUE } from "@/lib/autosend";

export interface ChatNavigation {
  /** The agent this chat dispatches to: the route's, via {@link useRouteVirtualMcpId}. */
  virtualMcpId: string;
  /** The thread the matched route names, or `null` where it names none. */
  taskId: string | null;
  /** Navigate to a task: the chat route, with the thread in `?thread=` and the
   *  agent in `?virtualmcpid=` — the one carrier of the project scope, written
   *  explicitly because retention would otherwise hand back the scope in force.
   *  `autosend` tells the route to consume the stored handoff message. */
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
   * The same route-aware answer the shell and the breadcrumb use: only the
   * routes whose agent IS the scope resolve `?virtualmcpid=`, so a leftover
   * filter on an org-level page cannot redirect a chat's messages.
   */
  const virtualMcpId = useRouteVirtualMcpId();
  const activeTabId = useActivePanelTabId();
  const search = useSearch({ strict: false }) as { sidepanel?: boolean };

  const navigateToTask = (
    taskId: string,
    opts?: { virtualMcpId?: string; autosend?: boolean },
  ) => {
    /** A view that belongs to the thread being left does not follow it; a
     *  system view does, as the `{-$panel}` segment. */
    const carried =
      activeTabId && !isPerThreadTab(activeTabId) ? activeTabId : undefined;
    const view = carried ? panelLocationForTab(carried) : null;
    navigate({
      to: DESTINATION_ROUTE.agents,
      params: { org: org.slug, panel: view?.panel },
      search: {
        virtualmcpid: opts?.virtualMcpId ?? virtualMcpId,
        thread: taskId,
        ...(view?.payload ?? {}),
        ...(typeof search.sidepanel === "boolean"
          ? { sidepanel: search.sidepanel }
          : {}),
        ...(opts?.autosend ? { autosend: AUTOSEND_QUERY_VALUE } : {}),
      },
    });
  };

  return { virtualMcpId, taskId, navigateToTask };
}
