import { LibraryTab } from "@/layouts/main-panel-tabs/library-tab";
import { WorkspaceRouteMain } from "./workspace-route-main";

export default function LibraryRoute() {
  return (
    <WorkspaceRouteMain contentClassName="overflow-hidden">
      <LibraryTab />
    </WorkspaceRouteMain>
  );
}
