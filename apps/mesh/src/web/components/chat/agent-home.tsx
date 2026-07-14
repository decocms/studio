import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
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

  return (
    <>
      {/* spacer — the agent name/branch already show in the breadcrumb, and
          this agent's threads live in the sidebar, so the empty chat just
          docks its input at the bottom */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden" />

      {/* docked input */}
      <Chat.Footer>
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
