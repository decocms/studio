import type { ReactNode } from "react";
import { VoiceInbox } from "@/layouts/task-board/voice-inbox";
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

function TaskBoardAccess({ children }: { children: ReactNode }) {
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
        {children}
      </FeatureGate>
    </ChatLayout.Content>
  );
}

export default function TasksRoute() {
  return (
    <TaskBoardAccess>
      <Board />
    </TaskBoardAccess>
  );
}

export function InboxRoute() {
  return (
    <TaskBoardAccess>
      <VoiceInbox />
    </TaskBoardAccess>
  );
}
