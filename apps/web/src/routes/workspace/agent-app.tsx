import { getRouteApi } from "@tanstack/react-router";
import { useRouteThreadId } from "@/layouts/thread-route";
import { useTaskMetadata } from "@/layouts/main-panel-tabs/use-task-metadata";
import { AppViewContent } from "@/routes/project-app-view";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/projects/$agentId/apps/$connectionId/$toolName",
);

export default function AppRoute() {
  const { connectionId, toolName } = route.useParams();
  const threadId = useRouteThreadId();
  const metadata = useTaskMetadata(threadId);
  const expandedTool = metadata?.expanded_tools?.find(
    (tool) => tool.appId === connectionId && tool.toolName === toolName,
  );
  return (
    <AppViewContent
      key={`${connectionId}:${toolName}`}
      connectionId={connectionId}
      toolName={toolName}
      args={expandedTool?.args}
    />
  );
}
