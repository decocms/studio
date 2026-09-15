import { WorkspacePage } from "@/layouts/workspace/workspace-page";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentSettingsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  return <SettingsTab virtualMcpId={virtualMcpId} />;
}

export default function AgentSettingsPage() {
  return (
    <WorkspacePage>
      <AgentSettingsContent />
    </WorkspacePage>
  );
}
