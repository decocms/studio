import { AutomationsListTab } from "@/layouts/main-panel-tabs/automations-list-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentRouteMain } from "./agent-route-main";

export default function AgentAutomationsRoute() {
  const agentId = useRouteVirtualMcpId();
  return (
    <AgentRouteMain contentMode="canvas">
      <AutomationsListTab virtualMcpId={agentId} />
    </AgentRouteMain>
  );
}
