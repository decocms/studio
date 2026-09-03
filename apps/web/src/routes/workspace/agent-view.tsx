import { getRouteApi } from "@tanstack/react-router";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AppViewContent } from "@/routes/project-app-view";
import { useVirtualMCP } from "@/sdk";
import { RouteNotFound } from "./route-not-found";
import { AgentRouteMain } from "./agent-route-main";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/agents/$agentId/views/$viewId",
);

export default function AgentViewRoute() {
  const { viewId } = route.useParams();
  const agentId = useRouteVirtualMcpId();
  const agent = useVirtualMCP(agentId);
  const view = agent?.metadata.ui?.layout?.tabs?.find(
    (tab) => tab.id === viewId,
  );

  return (
    <AgentRouteMain title={view?.title} contentClassName="overflow-hidden">
      {!view ? (
        <RouteNotFound />
      ) : (
        <AppViewContent
          connectionId={view.view.appId}
          toolName={view.id}
          args={view.view.args}
        />
      )}
    </AgentRouteMain>
  );
}
