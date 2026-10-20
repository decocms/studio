import { ChatLayout } from "@/components/chat-layout";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentSettingsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  return <SettingsTab virtualMcpId={virtualMcpId} />;
}

export default function AgentSettingsRoute() {
  return (
    <ChatLayout.Content>
      <AgentSettingsContent />
    </ChatLayout.Content>
  );
}
