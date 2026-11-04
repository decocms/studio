import { ChatLayout } from "@/components/chat-layout";
import { ServicesPage } from "@/components/services/services-page";

export default function AgentServicesRoute() {
  return (
    <ChatLayout.Content>
      <ServicesPage />
    </ChatLayout.Content>
  );
}
