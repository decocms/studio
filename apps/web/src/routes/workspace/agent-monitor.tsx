import { CdnTab } from "@/layouts/main-panel-tabs/cdn-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentRouteMain } from "./agent-route-main";
import { AgentViewGuard } from "./agent-view-guard";

export default function AgentMonitorRoute() {
  const agentId = useRouteVirtualMcpId();
  return (
    <AgentRouteMain contentClassName="overflow-hidden">
      <AgentViewGuard tabId="cdn">
        <CdnTab virtualMcpId={agentId} />
      </AgentViewGuard>
    </AgentRouteMain>
  );
}
