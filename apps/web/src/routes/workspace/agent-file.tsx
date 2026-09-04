import { getRouteApi } from "@tanstack/react-router";
import { FileTab } from "@/layouts/main-panel-tabs/file-tab";
import { useRouteThreadId } from "@/layouts/thread-route";
import { RouteNotFound } from "./route-not-found";
import { AgentRouteMain } from "./agent-route-main";
import { resolveRouteResourceTarget } from "./route-resource-title";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/agents/$agentId/outputs/file",
);

export default function AgentFileRoute() {
  const { key } = route.useSearch();
  const threadId = useRouteThreadId();
  const target = resolveRouteResourceTarget(key);

  return (
    <AgentRouteMain title={target?.title} contentMode="canvas">
      {target ? (
        <FileTab fileKey={target.value} taskId={threadId} />
      ) : (
        <RouteNotFound />
      )}
    </AgentRouteMain>
  );
}
