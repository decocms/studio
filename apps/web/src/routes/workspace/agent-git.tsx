import { ChatLayout } from "@/components/chat-layout";
import { AgentViewGuard } from "./agent-view-guard";
import { GitTab } from "@/components/thread/github/git-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentGitContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="git">
      <GitTab virtualMcpId={virtualMcpId} />
    </AgentViewGuard>
  );
}

export default function AgentGitRoute() {
  return (
    <ChatLayout.Content>
      <AgentGitContent />
    </ChatLayout.Content>
  );
}
