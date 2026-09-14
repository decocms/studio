import { ReportsTab } from "@/layouts/main-panel-tabs/reports-tab";
import { AgentRouteMain } from "./agent-route-main";

/** Workspace entry for the organization's existing store diagnostic. */
export default function ProjectReportsRoute() {
  return (
    <AgentRouteMain contentMode="canvas">
      <ReportsTab />
    </AgentRouteMain>
  );
}
