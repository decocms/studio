import { ChatLayout } from "@/components/chat-layout";
import { ExecutePage } from "@/layouts/content-track/execute-page";

export default function TasksRoute() {
  return (
    <ChatLayout.Content>
      <ExecutePage />
    </ChatLayout.Content>
  );
}
