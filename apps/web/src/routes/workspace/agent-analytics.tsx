import { AnalyticsTab } from "@/layouts/main-panel-tabs/analytics-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentRouteMain } from "./agent-route-main";
import { AgentViewGuard } from "./agent-view-guard";

export default function AgentAnalyticsRoute() {
  const agentId = useRouteVirtualMcpId();
  return (
    <AgentRouteMain contentMode="canvas">
      <AgentViewGuard tabId="analytics">
        <AnalyticsTab virtualMcpId={agentId} />
      </AgentViewGuard>
    </AgentRouteMain>
  );
}
