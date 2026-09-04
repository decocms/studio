import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentRouteMain } from "./agent-route-main";

export default function AgentSettingsRoute() {
  const agentId = useRouteVirtualMcpId();
  return (
    <AgentRouteMain contentMode="canvas">
      <SettingsTab virtualMcpId={agentId} />
    </AgentRouteMain>
  );
}
