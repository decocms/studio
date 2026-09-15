import { ReportsTab } from "@/layouts/main-panel-tabs/reports-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentRouteMain } from "./agent-route-main";

/** Project-owned store diagnostic. The canonical route id is also the
 * ownership key persisted on the organization's report connection. */
export default function ProjectReportsRoute() {
  const projectId = useRouteVirtualMcpId();

  return (
    <AgentRouteMain contentMode="canvas">
      <ReportsTab projectId={projectId} />
    </AgentRouteMain>
  );
}
