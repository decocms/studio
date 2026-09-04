import { getRouteApi } from "@tanstack/react-router";
import { toTitleCase } from "@/components/chat/message/parts/tool-call-part/utils";
import { useRouteThreadId, useRouteVirtualMcpId } from "@/layouts/thread-route";
import { useTaskMetadata } from "@/layouts/main-panel-tabs/use-task-metadata";
import { formatPinnedViewTabId } from "@/layouts/main-panel-tabs/tab-id";
import { resolveActiveRouteTitle } from "@/layouts/main-panel-tabs/active-route-title";
import { AppViewContent } from "@/routes/project-app-view";
import { useVirtualMCP } from "@/sdk";
import { AgentRouteMain } from "./agent-route-main";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/projects/$agentId/apps/$connectionId/$toolName",
);

export default function AgentAppRoute() {
  const { connectionId, toolName } = route.useParams();
  const agentId = useRouteVirtualMcpId();
  const agent = useVirtualMCP(agentId);
  const threadId = useRouteThreadId();
  const metadata = useTaskMetadata(threadId);
  const expandedTool = metadata?.expanded_tools?.find(
    (tool) => tool.appId === connectionId && tool.toolName === toolName,
  );
  const title =
    resolveActiveRouteTitle({
      activeTab: formatPinnedViewTabId(connectionId, toolName),
      pinnedViews: agent?.metadata.ui?.pinnedViews,
    }) ?? toTitleCase(toolName);

  return (
    <AgentRouteMain title={title} contentMode="canvas">
      <AppViewContent
        connectionId={connectionId}
        toolName={toolName}
        args={expandedTool?.args}
      />
    </AgentRouteMain>
  );
}
