import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { agentShowsGithubHeaderActions } from "@/web/lib/agent-capabilities";
import { HeaderActions } from "../../components/thread/github/header-actions.tsx";
import { DevAgentControl } from "../../components/dev-agent/dev-agent-control.tsx";

/**
 * The agent's header actions (dev-agent control + GitHub publish/PR buttons),
 * rendered inline into the main panel header's right cluster.
 */
export function VirtualMcpHeaderInfo({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  return (
    <div className="flex items-center gap-2">
      <DevAgentControl virtualMcp={virtualMcp} />
      {agentShowsGithubHeaderActions(virtualMcp) ? (
        <HeaderActions virtualMcpId={virtualMcp.id} />
      ) : null}
    </div>
  );
}
