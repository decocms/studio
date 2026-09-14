import { SiteEditorLayout } from "@/layouts/site-editor-layout";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

export default function AgentSiteEditorRoute() {
  const agentId = useRouteVirtualMcpId();
  return <SiteEditorLayout agentId={agentId} />;
}
