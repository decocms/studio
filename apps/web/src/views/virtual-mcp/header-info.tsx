import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { agentShowsGithubHeaderActions } from "@/lib/agent-capabilities";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { CmsHeaderActions } from "../../components/thread/github/cms-header-actions.tsx";
import { HeaderActions } from "../../components/thread/github/header-actions.tsx";
import { DevAgentControl } from "../../components/dev-agent/dev-agent-control.tsx";
import { OpenInBoardButton } from "../../components/thread/open-in-board-button.tsx";

/**
 * The agent's header actions (dev-agent control + GitHub publish/PR buttons),
 * rendered inline into the main panel header's right cluster.
 *
 * The CMS renderer swaps in here, not inside `HeaderActions`, so the sandbox
 * hooks that renderer mounts (events, lifecycle, publish gate) never mount on a
 * session that has no sandbox.
 */
export function VirtualMcpHeaderInfo({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  // The SESSION's runtime, not the project's: a coding session on a CMS-default
  // project gets the sandbox header, and the hooks that header mounts.
  const fastPreviewActive = useSessionRuntime(virtualMcp.id).runtime === "cms";

  return (
    <div className="flex items-center gap-2">
      <OpenInBoardButton />
      <DevAgentControl virtualMcp={virtualMcp} />
      {agentShowsGithubHeaderActions(virtualMcp) ? (
        fastPreviewActive ? (
          <CmsHeaderActions virtualMcpId={virtualMcp.id} />
        ) : (
          <HeaderActions virtualMcpId={virtualMcp.id} />
        )
      ) : null}
    </div>
  );
}
