import { getRouteApi } from "@tanstack/react-router";
import { LibraryFileTab } from "@/layouts/main-panel-tabs/library-file-tab";
import { RouteNotFound } from "./route-not-found";
import { AgentRouteMain } from "./agent-route-main";
import { resolveRouteResourceTarget } from "./route-resource-title";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/agents/$agentId/library/file",
);

export default function AgentLibraryFileRoute() {
  const { path } = route.useSearch();
  const target = resolveRouteResourceTarget(path);

  return (
    <AgentRouteMain title={target?.title} contentMode="canvas">
      {target ? <LibraryFileTab path={target.value} /> : <RouteNotFound />}
    </AgentRouteMain>
  );
}
