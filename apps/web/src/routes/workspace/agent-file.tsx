import { getRouteApi } from "@tanstack/react-router";
import { FileTab } from "@/layouts/main-panel-tabs/file-tab";
import { useRouteThreadId } from "@/layouts/thread-route";
import { RouteNotFound } from "./route-not-found";
import { AgentRouteMain } from "./agent-route-main";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/agents/$agentId/outputs/file",
);

export default function AgentFileRoute() {
  const { key } = route.useSearch();
  const threadId = useRouteThreadId();
  const title = key?.split("/").pop() ?? key;

  return (
    <AgentRouteMain title={title} contentClassName="overflow-hidden">
      {key ? <FileTab fileKey={key} taskId={threadId} /> : <RouteNotFound />}
    </AgentRouteMain>
  );
}
