import { AgentViewGuard } from "./agent-view-guard";
import { ContentTab } from "@/layouts/main-panel-tabs/content-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

export default function Route() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="content">
      <ContentTab virtualMcpId={virtualMcpId} />
    </AgentViewGuard>
  );
}
