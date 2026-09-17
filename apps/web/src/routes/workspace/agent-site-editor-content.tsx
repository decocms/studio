import { AgentViewGuard } from "./agent-view-guard";
import { FeatureGate } from "@/components/paywall/feature-gate";
import { ContentTab } from "@/layouts/main-panel-tabs/content-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

export default function ContentRoute() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="content">
      <FeatureGate feature="cms">
        <ContentTab virtualMcpId={virtualMcpId} />
      </FeatureGate>
    </AgentViewGuard>
  );
}
