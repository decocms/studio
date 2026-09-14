import { AgentViewGuard } from "./agent-view-guard";
import { AssetsTab } from "@/layouts/main-panel-tabs/assets-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

export default function Route() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="assets">
      <AssetsTab virtualMcpId={virtualMcpId} />
    </AgentViewGuard>
  );
}
