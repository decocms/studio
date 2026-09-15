import { ChatLayout } from "@/components/chat-layout";
import { DiscoverTab } from "@/layouts/main-panel-tabs/discover-tab";

export default function DiscoverRoute() {
  return (
    <ChatLayout.Content>
      <DiscoverTab />
    </ChatLayout.Content>
  );
}
