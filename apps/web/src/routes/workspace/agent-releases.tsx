import { ChatLayout } from "@/components/chat-layout";
import { AgentViewGuard } from "./agent-view-guard";
import { ReleasesTab } from "@/layouts/main-panel-tabs/releases-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentReleasesContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="releases">
      <ReleasesTab virtualMcpId={virtualMcpId} />
    </AgentViewGuard>
  );
}

export default function AgentReleasesRoute() {
  return (
    <ChatLayout.Content>
      <AgentReleasesContent />
    </ChatLayout.Content>
  );
}
