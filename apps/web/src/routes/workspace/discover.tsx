import { DiscoverTab } from "@/layouts/main-panel-tabs/discover-tab";
import { WorkspaceRouteMain } from "./workspace-route-main";

export default function DiscoverRoute() {
  return (
    <WorkspaceRouteMain contentMode="scroll">
      <DiscoverTab />
    </WorkspaceRouteMain>
  );
}
