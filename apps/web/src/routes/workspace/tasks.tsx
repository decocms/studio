import { ChatLayout } from "@/components/chat-layout";
import { TaskBoardPage } from "@/layouts/task-board";
import { FeatureGate } from "@/components/paywall/feature-gate";
import { PaywallBackdrop } from "@/components/paywall/paywall-backdrop";
import { mockBoardAnswer } from "@/components/paywall/mock-board";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";

function Board() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <TaskBoardPage />
    </div>
  );
}

export default function TasksRoute() {
  const { locator } = useProjectContext();
  return (
    <ChatLayout.Content>
      <FeatureGate
        feature="kanban"
        backdrop={
          <PaywallBackdrop
            seed={(client) =>
              client.setQueryData(
                KEYS.taskBoardItems(locator),
                mockBoardAnswer(),
              )
            }
          >
            <Board />
          </PaywallBackdrop>
        }
      >
        <Board />
      </FeatureGate>
    </ChatLayout.Content>
  );
}
