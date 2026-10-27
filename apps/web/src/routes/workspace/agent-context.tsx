import { ChatLayout } from "@/components/chat-layout";
import { ContextTab } from "@/layouts/main-panel-tabs/context-tab";

export default function AgentContextRoute() {
  return (
    <ChatLayout.Content>
      <ContextTab />
    </ChatLayout.Content>
  );
}
