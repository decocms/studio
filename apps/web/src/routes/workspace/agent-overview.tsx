import { ChatLayout } from "@/components/chat-layout";
import { OverviewTab } from "@/layouts/main-panel-tabs/overview-tab";

export default function AgentOverviewRoute() {
  return (
    <ChatLayout.Content>
      <OverviewTab />
    </ChatLayout.Content>
  );
}
