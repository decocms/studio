import { OverviewTab } from "@/layouts/main-panel-tabs/overview-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { useVirtualMCP } from "@/sdk";
import { AgentRouteMain } from "./agent-route-main";

export default function AgentOverviewRoute() {
  const agentId = useRouteVirtualMcpId();
  const agent = useVirtualMCP(agentId);

  return (
    <AgentRouteMain title={agent?.title} contentClassName="overflow-hidden">
      <OverviewTab />
    </AgentRouteMain>
  );
}
