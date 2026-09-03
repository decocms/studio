import { TaskBoardPage } from "@/layouts/task-board";
import { WorkspaceRouteMain } from "./workspace-route-main";

export default function TasksRoute() {
  return (
    <WorkspaceRouteMain contentClassName="overflow-hidden">
      <TaskBoardPage />
    </WorkspaceRouteMain>
  );
}
