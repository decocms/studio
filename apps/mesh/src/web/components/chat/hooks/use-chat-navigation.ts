import { useRef } from "react";
import { getWellKnownDecopilotVirtualMCP } from "@decocms/mesh-sdk";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { AUTOSEND_QUERY_VALUE } from "@/web/lib/autosend";

export interface ChatNavigation {
  /** Resolved vMCP for the current chat — either the URL param or the well-known decopilot. */
  virtualMcpId: string;
  /** Always defined — `/$org/$taskId` path param, or a stable fallback for routes that don't have it. */
  taskId: string;
  /** Navigate to a task. `virtualMcpId` becomes `?virtualmcpid=`. `autosend` tells the task route to consume the stored handoff message. */
  navigateToTask: (
    taskId: string,
    opts?: { virtualMcpId?: string; autosend?: boolean },
  ) => void;
}

export function useChatNavigation(): ChatNavigation {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const routeParams = useParams({ strict: false }) as { taskId?: string };

  const virtualMcpId =
    search.virtualmcpid ?? getWellKnownDecopilotVirtualMCP(org.id).id;

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
        if (prev.tasks) next.tasks = prev.tasks;
        if (prev.main) next.main = prev.main;
        if (prev.chat) next.chat = prev.chat;
        if (opts?.autosend) next.autosend = AUTOSEND_QUERY_VALUE;
        return next;
      },
    });
  };

  // On unified chat routes the taskId is a path param.
  // On other routes (e.g. settings) Chat.Provider still mounts but taskId is
  // absent — fall back to a stable generated ID so the provider works everywhere.
  const fallbackRef = useRef(crypto.randomUUID());
  const taskId = routeParams.taskId ?? fallbackRef.current;

  return { virtualMcpId, taskId, navigateToTask };
}
