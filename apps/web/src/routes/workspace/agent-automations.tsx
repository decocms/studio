import { ChatLayout } from "@/components/chat-layout";
import { AutomationsListTab } from "@/layouts/main-panel-tabs/automations-list-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentAutomationsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  return <AutomationsListTab virtualMcpId={virtualMcpId} />;
}

export default function AgentAutomationsRoute() {
  return (
    <ChatLayout.Content>
      <AgentAutomationsContent />
    </ChatLayout.Content>
  );
}
