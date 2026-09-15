import { ChatLayout } from "@/components/chat-layout";
import { ConnectSourcesTab } from "@/layouts/main-panel-tabs/connect-sources-tab";

export default function AgentConnectSourcesRoute() {
  return (
    <ChatLayout.Content>
      <ConnectSourcesTab />
    </ChatLayout.Content>
  );
}
