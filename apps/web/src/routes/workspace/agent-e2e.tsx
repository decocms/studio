import { WorkspacePage } from "@/layouts/workspace/workspace-page";
import { E2eTab } from "@/layouts/main-panel-tabs/e2e-tab";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentE2eContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  const views = useControlPlaneViews();
  return views.e2e ? (
    <E2eTab virtualMcpId={virtualMcpId} />
  ) : (
    <SettingsTab virtualMcpId={virtualMcpId} />
  );
}

export default function AgentE2ePage() {
  return (
    <WorkspacePage>
      <AgentE2eContent />
    </WorkspacePage>
  );
}
