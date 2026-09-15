import { WorkspacePage } from "@/layouts/workspace/workspace-page";
import { OrgAgentsTab } from "@/layouts/main-panel-tabs/org-agents-tab";

export default function HomePage() {
  return (
    <WorkspacePage>
      <OrgAgentsTab />
    </WorkspacePage>
  );
}
