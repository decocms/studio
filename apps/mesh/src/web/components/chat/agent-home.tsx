import { useParams } from "@tanstack/react-router";
import { useThreads } from "@/web/components/chat/store/hooks";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";
import { Chat } from "./index";
import { useChatPrefs, useChatTask } from "./context";
import { ChatModeRow } from "./pills/chat-mode-row";

export function AgentHome({
  onOpenContextPanel,
}: {
  onOpenContextPanel: () => void;
}) {
  const { org } = useProjectContext();
  const { selectedVirtualMcp } = useChatPrefs();
  const { currentBranch } = useChatTask();
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const agent = selectedVirtualMcp ?? defaultAgent;
  const fullVm = useVirtualMCP(agent.id);

  const { threads: allThreads } = useThreads();
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const { setTaskId } = usePanelActions();
  const { taskId: currentTaskId } = useParams({ strict: false }) as {
    taskId?: string;
  };

  const agentThreads = allThreads
    .filter(
      (t) =>
        !t.hidden &&
        t.virtual_mcp_id === agent.id &&
        // Don't list the thread you're already in — you're looking at it. This
        // is what keeps the Super Agent home from showing its own empty
        // "New chat" as a row above the composer.
        t.id !== currentTaskId &&
        // Owner-scoped; empty until the session resolves rather than leaking
        // every member's threads.
        t.created_by === currentUserId,
    )
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

  return (
    <>
      {/* spacer — the agent name/branch already show in the breadcrumb, so
          the empty chat just docks its input at the bottom */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden" />

      {/* docked input */}
      <Chat.Footer>
        {/* thread list — mt-auto pushes it to the bottom of the scroll area */}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
          <div className="mt-auto w-full max-w-2xl mx-auto px-2 pb-2 flex flex-col gap-0.5">
            {agentThreads.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                isActive={false}
                onClick={() => setTaskId(t.id, t.virtual_mcp_id)}
                showAutomationBadge={Boolean(t.trigger_id)}
              />
            ))}
          </div>
        </div>
        <Chat.IceBreakers className="pb-3" />
        <div
          data-chat-above-row="true"
          className="@container/chat-bottom pb-1 flex justify-start gap-1"
        >
          <ChatModeRow virtualMcp={fullVm} currentBranch={currentBranch} />
        </div>
        <Chat.Input onOpenContextPanel={onOpenContextPanel} />
      </Chat.Footer>
    </>
  );
}
