import { HostingTab } from "@/layouts/main-panel-tabs/hosting-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentRouteMain } from "./agent-route-main";
import { AgentViewGuard } from "./agent-view-guard";

export default function AgentHostingRoute() {
  const agentId = useRouteVirtualMcpId();
  return (
    <AgentRouteMain contentMode="canvas">
      <AgentViewGuard tabId="hosting">
        <HostingTab virtualMcpId={agentId} />
      </AgentViewGuard>
    </AgentRouteMain>
  );
}
