/**
 * useChatNavigation — URL-driven chat state.
 *
 * Reads virtualMcpId from route params and taskId from search params.
 * virtualMcpId is never null — defaults to the well-known decopilot virtual MCP.
 * virtualMcpOverride is an optional search param for ephemeral per-task agent switching.
 */

import { useRef } from "react";
import { getWellKnownDecopilotVirtualMCP } from "@decocms/mesh-sdk";
import { useMatch, useNavigate, useSearch } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";

export interface ChatNavigation {
  virtualMcpId: string;
  virtualMcpOverride: string | undefined;
  /** Always defined — the router's validateSearch seeds a UUID if absent. */
  taskId: string;
  navigateToTask: (
    taskId: string,
    opts?: { virtualMcpOverride?: string },
  ) => void;
  setVirtualMcpOverride: (id: string | null) => void;
}

export function useChatNavigation(): ChatNavigation {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const search = useSearch({ strict: false }) as {
    taskId?: string;
    virtualMcpOverride?: string;
  };

  const agentsMatch = useMatch({
    from: "/shell/$org/$virtualMcpId",
    shouldThrow: false,
  });

  const virtualMcpId =
    agentsMatch?.params.virtualMcpId ??
    getWellKnownDecopilotVirtualMCP(org.id).id;

  const navigateToTask = (
    taskId: string,
    opts?: { virtualMcpOverride?: string },
  ) => {
    console.log("[useChatNavigation] navigateToTask", { taskId, agentsMatch: !!agentsMatch, virtualMcpId, currentPath: window.location.pathname });
    if (agentsMatch) {
      navigate({
        to: "/$org/$virtualMcpId/",
        params: {
          org: org.slug,
          virtualMcpId,
        },
        search: (prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev, taskId };
          if (opts?.virtualMcpOverride) {
            next.virtualMcpOverride = opts.virtualMcpOverride;
          } else {
            delete next.virtualMcpOverride;
          }
          return next;
        },
      });
    } else {
      navigate({
        search: (prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev, taskId };
          if (opts?.virtualMcpOverride) {
            next.virtualMcpOverride = opts.virtualMcpOverride;
          } else {
            delete next.virtualMcpOverride;
          }
          return next;
        },
      } as never);
    }
  };

  const setVirtualMcpOverride = (id: string | null) => {
    navigate({
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev };
        if (id) {
          next.virtualMcpOverride = id;
        } else {
          delete next.virtualMcpOverride;
        }
        return next;
      },
    } as never);
  };

  // On agent routes the router's validateSearch seeds taskId automatically.
  // On other routes (e.g. settings) Chat.Provider still mounts but taskId is
  // absent — fall back to a stable generated ID so the provider works everywhere.
  const fallbackRef = useRef(crypto.randomUUID());
  const taskId = search.taskId ?? fallbackRef.current;

  return {
    virtualMcpId,
    virtualMcpOverride: search.virtualMcpOverride,
    taskId,
    navigateToTask,
    setVirtualMcpOverride,
  };
}
