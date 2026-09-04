import { getRouteApi } from "@tanstack/react-router";
import { DeckTab } from "@/layouts/main-panel-tabs/deck-tab";
import { RouteNotFound } from "./route-not-found";
import { AgentRouteMain } from "./agent-route-main";
import { resolveRouteResourceTarget } from "./route-resource-title";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/agents/$agentId/outputs/deck",
);

export default function AgentDeckRoute() {
  const { path } = route.useSearch();
  const target = resolveRouteResourceTarget(path, (leaf) =>
    leaf.replace(/\.html$/i, ""),
  );

  return (
    <AgentRouteMain title={target?.title} contentMode="canvas">
      {target ? <DeckTab path={target.value} /> : <RouteNotFound />}
    </AgentRouteMain>
  );
}
