import { ChatLayout } from "@/components/chat-layout";
import { ComingSoonPage } from "@/components/coming-soon/coming-soon-page";

export default function MonitoringRoute() {
  return (
    <ChatLayout.Content>
      <ComingSoonPage kind="monitor" />
    </ChatLayout.Content>
  );
}
