import { AgentViewGuard } from "./agent-view-guard";
import { PreviewTab } from "@/layouts/main-panel-tabs/preview-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

export default function Route() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="site-editor">
      <PreviewTab virtualMcpId={virtualMcpId} />
    </AgentViewGuard>
  );
}
