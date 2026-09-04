import { ReportsTab } from "@/layouts/main-panel-tabs/reports-tab";
import { WorkspaceRouteMain } from "./workspace-route-main";

export default function ReportsRoute() {
  return (
    <WorkspaceRouteMain contentMode="canvas">
      <ReportsTab />
    </WorkspaceRouteMain>
  );
}
