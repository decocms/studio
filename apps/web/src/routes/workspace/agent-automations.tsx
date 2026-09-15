import { WorkspacePage } from "@/layouts/workspace/workspace-page";
import { AutomationsListTab } from "@/layouts/main-panel-tabs/automations-list-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentAutomationsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  return <AutomationsListTab virtualMcpId={virtualMcpId} />;
}

export default function AgentAutomationsPage() {
  return (
    <WorkspacePage>
      <AgentAutomationsContent />
    </WorkspacePage>
  );
}
