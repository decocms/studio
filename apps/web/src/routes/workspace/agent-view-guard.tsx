import type { ReactNode } from "react";
import { getRouteApi, Navigate } from "@tanstack/react-router";
import { AGENT_ROUTE } from "@/hooks/use-destination-route";
import { useMainPanelTabs } from "@/layouts/main-panel-tabs/main-panel-tabs-context";
import { resolvePanelNavigationSearch } from "@/layouts/main-panel-tabs/panel-navigation-search";

const agentRoute = getRouteApi(
  "/shell/$org/org-shell/agent-shell/agents/$agentId",
);

/**
 * Keeps a deep link from bypassing the same capability and rollout checks used
 * by the workspace navigation. Pending capabilities remain on the requested
 * tab (the resolver deliberately holds them); a proven-unavailable view falls
 * back to Settings (the one guaranteed agent route) before its body mounts.
 */
export function AgentViewGuard({
  children,
  tabId,
}: {
  children: ReactNode;
  tabId: string;
}) {
  const params = agentRoute.useParams();
  const agentId = params.agentId;
  const { activeTab } = useMainPanelTabs();

  const requestedViewIsActive =
    tabId === "code"
      ? activeTab === "code" || activeTab.startsWith("code:")
      : activeTab === tabId;

  if (requestedViewIsActive) return children;

  return (
    <Navigate
      to={AGENT_ROUTE.settings}
      params={{ org: params.org, agentId }}
      search={(prev) =>
        resolvePanelNavigationSearch({
          previous: prev,
          destination: "agent",
        })
      }
      replace
    />
  );
}
