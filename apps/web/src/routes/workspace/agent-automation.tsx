import { ChatLayout } from "@/components/chat-layout";
import { useParams } from "@tanstack/react-router";
import { AutomationTab } from "@/layouts/main-panel-tabs/automation-tab";

function AgentAutomationContent() {
  const { automationId } = useParams({ strict: false });
  return automationId ? (
    <AutomationTab tabId={`automation:${automationId}`} />
  ) : null;
}

export default function AgentAutomationRoute() {
  return (
    <ChatLayout.Content>
      <AgentAutomationContent />
    </ChatLayout.Content>
  );
}
