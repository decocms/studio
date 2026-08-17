import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { agentShowsGithubHeaderActions } from "@/lib/agent-capabilities";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { CmsHeaderActions } from "../../components/thread/github/cms-header-actions.tsx";
import { HeaderActions } from "../../components/thread/github/header-actions.tsx";
import { DevAgentControl } from "../../components/dev-agent/dev-agent-control.tsx";
import { OpenInBoardButton } from "../../components/thread/open-in-board-button.tsx";

/**
 * The agent's header actions (dev-agent control + GitHub publish/PR buttons),
 * rendered inline into the main panel header's right cluster.
 *
 * A sandbox-less branch swaps in the CMS renderer here, not inside
 * `HeaderActions`, so the sandbox hooks that renderer mounts (events,
 * lifecycle, publish gate) never mount on a surface that has no sandbox. Once
 * the branch has a pod the vibecoding renderer takes over — same project.
 */
export function VirtualMcpHeaderInfo({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  const { cmsModeActive } = useSandboxLifecycle();

  return (
    <div className="flex items-center gap-2">
      <OpenInBoardButton />
      <DevAgentControl virtualMcp={virtualMcp} />
      {agentShowsGithubHeaderActions(virtualMcp) ? (
        cmsModeActive ? (
          <CmsHeaderActions virtualMcpId={virtualMcp.id} />
        ) : (
          <HeaderActions virtualMcpId={virtualMcp.id} />
        )
      ) : null}
    </div>
  );
}
