/**
 * useNavigateToAgent — navigates to an agent and adds it to the sidebar.
 *
 * Shared hook used by sidebar, home page, and /agents route to handle
 * agent navigation with automatic personal sidebar membership.
 */

import { useProjectContext, useVirtualMCPs } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { authClient } from "@/web/lib/auth-client";
import { appendAgentToPersonalOrder } from "@/web/components/sidebar/task-groups/stable-order";
import { useBumpSidebarOrderRevision } from "@/web/components/sidebar/sidebar-agent-groups-context";

interface NavigateToAgentOptions {
  search?: Record<string, unknown>;
}

export function useNavigateToAgent() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const allAgents = useVirtualMCPs();
  const { data: session } = authClient.useSession();
  const sidebarUserId = session?.user?.id ?? "anon";
  const serverPinnedIds = allAgents.filter((a) => !!a.pinned).map((a) => a.id);
  const bumpOrderRevision = useBumpSidebarOrderRevision();

  return (virtualMcpId: string, options?: NavigateToAgentOptions) => {
    appendAgentToPersonalOrder(
      { orgId: org.id, userId: sidebarUserId },
      virtualMcpId,
      serverPinnedIds,
    );
    bumpOrderRevision();
    const taskId = crypto.randomUUID();
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId },
      search: { ...(options?.search ?? {}), virtualmcpid: virtualMcpId },
    });
  };
}
