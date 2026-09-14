import { TaskBoardPage } from "@/layouts/task-board";

export default function TasksRoute() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <TaskBoardPage />
    </div>
  );
}
