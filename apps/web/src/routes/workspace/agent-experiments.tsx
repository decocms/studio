import { ChatLayout } from "@/components/chat-layout";
import { ExperimentsTab } from "@/layouts/main-panel-tabs/experiments-tab";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentExperimentsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  const views = useControlPlaneViews();
  return views.experiments ? (
    <ExperimentsTab virtualMcpId={virtualMcpId} />
  ) : (
    <SettingsTab virtualMcpId={virtualMcpId} />
  );
}

export default function AgentExperimentsRoute() {
  return (
    <ChatLayout.Content>
      <AgentExperimentsContent />
    </ChatLayout.Content>
  );
}
