import { useParams } from "@tanstack/react-router";
import { TaskBoardPage } from "@/layouts/task-board";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentRouteMain } from "./agent-route-main";

export default function ProjectTasksRoute() {
  const params = useParams({ strict: false });
  const projectId = useRouteVirtualMcpId();
  const selectedTaskKey =
    "taskKey" in params && typeof params.taskKey === "string"
      ? params.taskKey
      : undefined;

  return (
    <AgentRouteMain
      contentMode="canvas"
      title={selectedTaskKey}
      boundaryKey={
        selectedTaskKey
          ? `project-tasks:${projectId}:detail:${selectedTaskKey}`
          : `project-tasks:${projectId}:list`
      }
    >
      <TaskBoardPage routeProjectId={projectId} />
    </AgentRouteMain>
  );
}
