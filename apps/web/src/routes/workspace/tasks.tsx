import { ChatLayout } from "@/components/chat-layout";
import { TaskBoardPage } from "@/layouts/task-board";

export default function TasksRoute() {
  return (
    <ChatLayout.Content>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <TaskBoardPage />
      </div>
    </ChatLayout.Content>
  );
}
