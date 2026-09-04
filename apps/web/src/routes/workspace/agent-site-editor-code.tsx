import { getRouteApi } from "@tanstack/react-router";
import { CodeTab } from "@/layouts/main-panel-tabs/code-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentViewGuard } from "./agent-view-guard";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/projects/$agentId/site-editor/code",
);

export default function AgentSiteEditorCodeRoute() {
  const agentId = useRouteVirtualMcpId();
  const { file } = route.useSearch();
  return (
    <AgentViewGuard tabId="code">
      <CodeTab virtualMcpId={agentId} openPath={file ?? null} />
    </AgentViewGuard>
  );
}
