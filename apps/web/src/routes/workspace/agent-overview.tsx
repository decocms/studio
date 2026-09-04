import { OverviewTab } from "@/layouts/main-panel-tabs/overview-tab";
import { AgentRouteMain } from "./agent-route-main";

export default function AgentOverviewRoute() {
  return (
    <AgentRouteMain agentRoot contentClassName="overflow-hidden">
      <OverviewTab />
    </AgentRouteMain>
  );
}
