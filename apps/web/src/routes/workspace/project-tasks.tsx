import { WorkspacePage } from "@/layouts/workspace/workspace-page";
import { TaskBoardPage } from "@/layouts/task-board";

export default function ProjectTasksPage() {
  return (
    <WorkspacePage>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <TaskBoardPage />
      </div>
    </WorkspacePage>
  );
}
