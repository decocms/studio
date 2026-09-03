import { getRouteApi } from "@tanstack/react-router";
import { DeckTab } from "@/layouts/main-panel-tabs/deck-tab";
import { RouteNotFound } from "./route-not-found";
import { AgentRouteMain } from "./agent-route-main";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/agents/$agentId/outputs/deck",
);

export default function AgentDeckRoute() {
  const { path } = route.useSearch();
  const title = path
    ? (path.split("/").pop() ?? path).replace(/\.html$/i, "")
    : undefined;

  return (
    <AgentRouteMain title={title} contentClassName="overflow-hidden">
      {path ? <DeckTab path={path} /> : <RouteNotFound />}
    </AgentRouteMain>
  );
}
