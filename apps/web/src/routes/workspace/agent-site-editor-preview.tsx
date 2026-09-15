import { PreviewTab } from "@/layouts/main-panel-tabs/preview-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

export default function AgentSiteEditorPreviewRoute() {
  const agentId = useRouteVirtualMcpId();
  return <PreviewTab virtualMcpId={agentId} />;
}
