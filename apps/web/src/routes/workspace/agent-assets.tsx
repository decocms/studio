import { AssetsTab } from "@/layouts/main-panel-tabs/assets-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentRouteMain } from "./agent-route-main";
import { AgentViewGuard } from "./agent-view-guard";

export default function AgentAssetsRoute() {
  const agentId = useRouteVirtualMcpId();
  return (
    <AgentRouteMain contentClassName="overflow-hidden">
      <AgentViewGuard tabId="assets">
        <AssetsTab virtualMcpId={agentId} />
      </AgentViewGuard>
    </AgentRouteMain>
  );
}
