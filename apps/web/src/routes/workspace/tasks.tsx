import { useParams } from "@tanstack/react-router";
import { TaskBoardPage } from "@/layouts/task-board";
import { WorkspaceRouteMain } from "./workspace-route-main";

export default function TasksRoute() {
  const params = useParams({ strict: false });
  const selectedTaskKey =
    "taskKey" in params && typeof params.taskKey === "string"
      ? params.taskKey
      : undefined;

  return (
    <WorkspaceRouteMain
      contentMode="canvas"
      title={selectedTaskKey}
      boundaryKey={
        selectedTaskKey ? `tasks:detail:${selectedTaskKey}` : "tasks:list"
      }
    >
      <TaskBoardPage />
    </WorkspaceRouteMain>
  );
}
