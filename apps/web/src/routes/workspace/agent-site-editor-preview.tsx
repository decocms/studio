import { AgentViewGuard } from "./agent-view-guard";
import { FeatureGate } from "@/components/paywall/feature-gate";
import { PreviewTab } from "@/layouts/main-panel-tabs/preview-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

export default function PreviewRoute() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="site-editor">
      <FeatureGate feature="cms">
        <PreviewTab virtualMcpId={virtualMcpId} />
      </FeatureGate>
    </AgentViewGuard>
  );
}
