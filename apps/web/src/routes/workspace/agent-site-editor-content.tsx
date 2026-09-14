import { ContentTab } from "@/layouts/main-panel-tabs/content-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentViewGuard } from "./agent-view-guard";

export default function AgentSiteEditorContentRoute() {
  const agentId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="content">
      <ContentTab virtualMcpId={agentId} />
    </AgentViewGuard>
  );
}
