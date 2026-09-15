import { ChatLayout } from "@/components/chat-layout";
import { OrgAgentsTab } from "@/layouts/main-panel-tabs/org-agents-tab";

export default function HomeRoute() {
  return (
    <ChatLayout.Content>
      <OrgAgentsTab />
    </ChatLayout.Content>
  );
}
