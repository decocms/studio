import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@/sdk";
import { isPerThreadTab } from "@/layouts/main-panel-tabs/tab-id";
import { useRouteThreadId, useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AUTOSEND_QUERY_VALUE } from "@/lib/autosend";

export interface ChatNavigation {
  /** The agent this chat dispatches to: the route's, via {@link useRouteVirtualMcpId}. */
  virtualMcpId: string;
  /** The thread the matched route names, or `null` where it names none. */
  taskId: string | null;
  /** Navigate to a task. `virtualMcpId` becomes `?virtualmcpid=`. `autosend` tells the task route to consume the stored handoff message. */
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
   * The same route-aware answer the shell and the breadcrumb use. Reading only
   * `?virtualmcpid=` made a chat on `/$org/chat/<project>` — where that param
   * is absent by construction — dispatch its messages to the Super Agent.
   */
  const virtualMcpId = useRouteVirtualMcpId();

  const navigateToTask = (
    taskId: string,
    opts?: { virtualMcpId?: string; autosend?: boolean },
  ) => {
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId },
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = {};
        const vmcp = opts?.virtualMcpId ?? prev.virtualmcpid;
        if (vmcp) next.virtualmcpid = vmcp;
        const prevMain = prev.main;
        if (
          prevMain &&
          typeof prevMain === "string" &&
          !isPerThreadTab(prevMain)
        )
          next.main = prevMain;
        if (typeof prev.sidepanel === "boolean") {
          next.sidepanel = prev.sidepanel;
        }
        if (opts?.autosend) next.autosend = AUTOSEND_QUERY_VALUE;
        return next;
      },
    });
  };

  return { virtualMcpId, taskId, navigateToTask };
}
