import { ChatLayout } from "@/components/chat-layout";
import { PlanPage } from "@/components/plan/plan-page";

export default function PlanRoute() {
  return (
    <ChatLayout.Content>
      <PlanPage />
    </ChatLayout.Content>
  );
}
