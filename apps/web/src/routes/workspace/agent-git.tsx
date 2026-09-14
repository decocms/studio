import { AgentViewGuard } from "./agent-view-guard";
import { GitTab } from "@/components/thread/github/git-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

export default function Route() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="git">
      <GitTab virtualMcpId={virtualMcpId} />
    </AgentViewGuard>
  );
}
