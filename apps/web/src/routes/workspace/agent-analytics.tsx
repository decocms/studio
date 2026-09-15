import { ChatLayout } from "@/components/chat-layout";
import { AnalyticsTab } from "@/layouts/main-panel-tabs/analytics-tab";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentAnalyticsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  const views = useControlPlaneViews();
  return views.analytics ? (
    <AnalyticsTab virtualMcpId={virtualMcpId} />
  ) : (
    <SettingsTab virtualMcpId={virtualMcpId} />
  );
}

export default function AgentAnalyticsRoute() {
  return (
    <ChatLayout.Content>
      <AgentAnalyticsContent />
    </ChatLayout.Content>
  );
}
