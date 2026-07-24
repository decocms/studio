/**
 * useNavigateToAgent — navigates to an agent and adds it to the sidebar.
 *
 * Shared hook used by sidebar, home page, and /agents route to handle
 * agent navigation with automatic personal sidebar membership.
 */

import { useProjectContext, useVirtualMCPs } from "@/sdk";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useNavigate } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { authClient } from "@/lib/auth-client";
import { appendAgentToPersonalOrder } from "@/components/sidebar/task-groups/stable-order";
import { useBumpSidebarOrderRevision } from "@/components/sidebar/sidebar-agent-groups-context";
import { useOptionalThreadManager } from "@/components/chat/store/hooks";
import type { Task } from "@/components/chat/task/types";
import { findReusableNewChat } from "@/lib/reusable-new-chat";

const NO_THREADS: Task[] = [];
const noopSubscribe = () => () => {};

interface NavigateToAgentOptions {
  search?: Record<string, unknown>;
}

export function getServerPinnedIds(
  agents: VirtualMCPEntity[] | undefined | null,
): string[] {
  return (agents ?? []).filter((a) => !!a.pinned).map((a) => a.id);
}

export function useNavigateToAgent() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const allAgents = useVirtualMCPs();
  const { data: session } = authClient.useSession();
  const sidebarUserId = session?.user?.id ?? "anon";
  const serverPinnedIds = getServerPinnedIds(allAgents);
  const bumpOrderRevision = useBumpSidebarOrderRevision();

  // Read the open-thread list (when a ThreadManagerProvider is in scope) so we
  // can reuse an agent's empty "New chat" instead of minting a duplicate every
  // time it's navigated to. Falls back to an empty list off-provider.
  const manager = useOptionalThreadManager();
  const threads = useSyncExternalStore(
    manager?.threads.subscribe ?? noopSubscribe,
    manager?.threads.get ?? (() => NO_THREADS),
    manager?.threads.get ?? (() => NO_THREADS),
  );

  return (virtualMcpId: string, options?: NavigateToAgentOptions) => {
    appendAgentToPersonalOrder(
      { orgId: org.id, userId: sidebarUserId },
      virtualMcpId,
      serverPinnedIds,
    );
    bumpOrderRevision();
    // Focus the agent's existing empty chat if it has one; otherwise a fresh id
    // (the route loader's ensure-fallback creates the thread on landing).
    const taskId =
      findReusableNewChat(threads, virtualMcpId, session?.user?.id)?.id ??
      crypto.randomUUID();
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId },
      search: { ...(options?.search ?? {}), virtualmcpid: virtualMcpId },
    });
  };
}
