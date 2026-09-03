import { ConnectSourcesTab } from "@/layouts/main-panel-tabs/connect-sources-tab";
import { AgentRouteMain } from "./agent-route-main";

export default function AgentConnectSourcesRoute() {
  return (
    <AgentRouteMain contentClassName="overflow-hidden">
      <ConnectSourcesTab />
    </AgentRouteMain>
  );
}
