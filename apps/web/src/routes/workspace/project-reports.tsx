import { ChatLayout } from "@/components/chat-layout";
import { ReportsTab } from "@/layouts/main-panel-tabs/reports-tab";

export default function ProjectReportsRoute() {
  return (
    <ChatLayout.Content>
      <ReportsTab />
    </ChatLayout.Content>
  );
}
