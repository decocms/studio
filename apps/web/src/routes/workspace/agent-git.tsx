import { GitTab } from "@/components/thread/github/git-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentRouteMain } from "./agent-route-main";
import { AgentViewGuard } from "./agent-view-guard";

export default function AgentGitRoute() {
  const agentId = useRouteVirtualMcpId();
  return (
    <AgentRouteMain contentClassName="overflow-hidden">
      <AgentViewGuard tabId="git">
        <GitTab virtualMcpId={agentId} />
      </AgentViewGuard>
    </AgentRouteMain>
  );
}
