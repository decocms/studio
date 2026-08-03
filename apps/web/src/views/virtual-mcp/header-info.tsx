import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useChatTask } from "@/components/chat/context";
import { agentShowsGithubHeaderActions } from "@/lib/agent-capabilities";
import { HeaderActions } from "../../components/thread/github/header-actions.tsx";
import { DevAgentControl } from "../../components/dev-agent/dev-agent-control.tsx";
import { OpenInBoardButton } from "../../components/thread/open-in-board-button.tsx";

/**
 * The agent's header actions (dev-agent control + GitHub publish/PR buttons),
 * rendered inline into the main panel header's right cluster.
 */
export function VirtualMcpHeaderInfo({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  const { canMutateThread } = useChatTask();

  return (
    <div className="flex items-center gap-2">
      <OpenInBoardButton />
      <DevAgentControl virtualMcp={virtualMcp} />
      {canMutateThread && agentShowsGithubHeaderActions(virtualMcp) ? (
        <HeaderActions virtualMcpId={virtualMcp.id} />
      ) : null}
    </div>
  );
}
