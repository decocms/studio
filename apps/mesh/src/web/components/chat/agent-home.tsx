import { IntegrationIcon } from "@/web/components/integration-icon";
import { useThreads } from "@/web/components/chat/store/hooks";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { Users03 } from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";
import { Chat } from "./index";
import { useChatPrefs } from "./context";
import { ChatModeRow } from "./pills/chat-mode-row";

export function AgentHome({
  onOpenContextPanel,
}: {
  onOpenContextPanel: () => void;
}) {
  const { org } = useProjectContext();
  const { selectedVirtualMcp } = useChatPrefs();
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const agent = selectedVirtualMcp ?? defaultAgent;
  const fullVm = useVirtualMCP(agent.id);

  const { threads: allThreads } = useThreads();
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const { setTaskId } = usePanelActions();

  const agentThreads = allThreads
    .filter(
      (t) =>
        !t.hidden &&
        t.virtual_mcp_id === agent.id &&
        // Owner-scoped; empty until the session resolves rather than leaking
        // every member's threads.
        t.created_by === currentUserId,
    )
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* compact agent header */}
        <div className="w-full max-w-2xl mx-auto px-4 pt-8 pb-4 flex items-center gap-3">
          <IntegrationIcon
            icon={agent.icon}
            name={agent.title}
            size="sm"
            fallbackIcon={<Users03 size={16} />}
            className="size-8 min-w-8 rounded-lg shrink-0"
          />
          <span className="font-medium text-base text-foreground truncate">
            {agent.title}
          </span>
        </div>
      </div>

      {/* docked input */}
      <Chat.Footer>
        <Chat.IceBreakers className="pb-3" />
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
        <div
          data-chat-above-row="true"
          className="@container/chat-bottom pb-1 flex justify-start gap-1"
        >
          <ChatModeRow virtualMcp={fullVm} currentBranch={null} />
        </div>
        <Chat.Input onOpenContextPanel={onOpenContextPanel} />
      </Chat.Footer>
    </>
  );
}
