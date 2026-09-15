import { WorkspacePage } from "@/layouts/workspace/workspace-page";
import { HostingTab } from "@/layouts/main-panel-tabs/hosting";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentHostingContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  const views = useControlPlaneViews();
  return views.hosting ? (
    <HostingTab virtualMcpId={virtualMcpId} />
  ) : (
    <SettingsTab virtualMcpId={virtualMcpId} />
  );
}

export default function AgentHostingPage() {
  return (
    <WorkspacePage>
      <AgentHostingContent />
    </WorkspacePage>
  );
}
