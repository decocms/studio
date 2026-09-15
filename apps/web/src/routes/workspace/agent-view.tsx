import { WorkspacePage } from "@/layouts/workspace/workspace-page";
import { getRouteApi } from "@tanstack/react-router";
import { AppViewContent } from "@/routes/project-app-view";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useVirtualMCP } from "@/sdk";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/projects/$agentId/views/$viewId",
);

function AgentViewContent() {
  const { agentId, viewId } = route.useParams();
  const agent = useVirtualMCP(agentId);
  const tab = agent?.metadata?.ui?.layout?.tabs?.find(
    (tab) => tab.id === viewId,
  );
  return tab ? (
    <AppViewContent
      key={viewId}
      connectionId={tab.view.appId}
      toolName={tab.id}
      args={tab.view.args}
    />
  ) : (
    <SettingsTab virtualMcpId={agentId} />
  );
}

export default function AgentViewPage() {
  return (
    <WorkspacePage>
      <AgentViewContent />
    </WorkspacePage>
  );
}
