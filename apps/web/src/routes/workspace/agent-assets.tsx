import { WorkspacePage } from "@/layouts/workspace/workspace-page";
import { AgentViewGuard } from "./agent-view-guard";
import { AssetsTab } from "@/layouts/main-panel-tabs/assets-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

function AgentAssetsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="assets">
      <AssetsTab virtualMcpId={virtualMcpId} />
    </AgentViewGuard>
  );
}

export default function AgentAssetsPage() {
  return (
    <WorkspacePage>
      <AgentAssetsContent />
    </WorkspacePage>
  );
}
