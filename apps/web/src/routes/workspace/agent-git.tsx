import { WorkspacePage } from "@/layouts/workspace/workspace-page";
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

export default function AgentGitPage() {
  return (
    <WorkspacePage>
      <AgentGitContent />
    </WorkspacePage>
  );
}
