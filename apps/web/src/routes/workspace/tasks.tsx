import { useParams } from "@tanstack/react-router";
import { TaskBoardPage } from "@/layouts/task-board";
import { useT } from "@/i18n/use-t";
import { useProjectContext } from "@/sdk";
import { WorkspaceRouteMain } from "./workspace-route-main";

export default function TasksRoute() {
  const t = useT();
  const { org } = useProjectContext();
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
      breadcrumbAncestors={
        selectedTaskKey
          ? [
              {
                id: "tasks",
                label: t("taskBoard.taskBoard.tasksTitle"),
                link: {
                  to: "/$org/tasks/{-$taskKey}",
                  params: { org: org.slug, taskKey: undefined },
                  search: (previous: Record<string, unknown>) => previous,
                  replace: true,
                },
              },
            ]
          : undefined
      }
    >
      <TaskBoardPage />
    </WorkspaceRouteMain>
  );
}
