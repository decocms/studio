import { getRouteApi } from "@tanstack/react-router";
import { AutomationTab } from "@/layouts/main-panel-tabs/automation-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentRouteMain } from "./agent-route-main";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/agents/$agentId/automations/$automationId",
);

export default function AgentAutomationRoute() {
  const { automationId } = route.useParams();
  const agentId = useRouteVirtualMcpId();
  return (
    <AgentRouteMain contentClassName="overflow-hidden">
      <AutomationTab
        tabId={`automation:${automationId}`}
        routeAgentId={agentId}
      />
    </AgentRouteMain>
  );
}
