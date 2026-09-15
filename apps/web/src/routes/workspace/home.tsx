import { OrgAgentsTab } from "@/layouts/main-panel-tabs/org-agents-tab";
import { WorkspaceRouteMain } from "./workspace-route-main";

export default function HomeRoute() {
  return (
    <WorkspaceRouteMain hideTitle contentMode="scroll">
      <OrgAgentsTab />
    </WorkspaceRouteMain>
  );
}
