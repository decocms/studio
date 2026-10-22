import { ChatLayout } from "@/components/chat-layout";
import { ComingSoonPage } from "@/components/coming-soon/coming-soon-page";

export default function PlanRoute() {
  return (
    <ChatLayout.Content>
      <ComingSoonPage kind="plan" />
    </ChatLayout.Content>
  );
}
