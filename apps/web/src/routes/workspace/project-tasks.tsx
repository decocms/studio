import { useParams } from "@tanstack/react-router";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t";
import { TaskBoardPage } from "@/layouts/task-board";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { projectRepo } from "@/lib/github-repo";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { AgentRouteMain } from "./agent-route-main";

export default function ProjectTasksRoute() {
  const t = useT();
  const params = useParams({ strict: false });
  const { org } = useProjectContext();
  const projectId = useRouteVirtualMcpId();
  const project = useVirtualMCP(projectId);
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
      breadcrumbAncestors={
        selectedTaskKey
          ? [
              {
                id: `project:${projectId}:tasks`,
                label: t("taskBoard.taskBoard.tasksTitle"),
                link: {
                  to: PROJECT_ROUTE.tasks,
                  params: {
                    org: org.slug,
                    agentId: projectId,
                    taskKey: undefined,
                  },
                  search: (previous: Record<string, unknown>) => previous,
                  replace: true,
                },
              },
            ]
          : undefined
      }
    >
      <TaskBoardPage projectScope={{ projectId, repo: projectRepo(project) }} />
    </AgentRouteMain>
  );
}
