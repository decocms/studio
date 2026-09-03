import { ReportsTab } from "@/layouts/main-panel-tabs/reports-tab";
import { WorkspaceRouteMain } from "./workspace-route-main";

export default function ReportsRoute() {
  return (
    <WorkspaceRouteMain contentClassName="overflow-hidden">
      <ReportsTab />
    </WorkspaceRouteMain>
  );
}
