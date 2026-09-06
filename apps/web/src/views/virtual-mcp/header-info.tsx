import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { agentShowsGithubHeaderActions } from "@/lib/agent-capabilities";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { isSurfaceTab } from "@/layouts/main-panel-tabs/source-system-tabs";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { CmsHeaderActions } from "../../components/thread/github/cms-header-actions.tsx";
import { HeaderActions } from "../../components/thread/github/header-actions.tsx";
import { DevAgentControl } from "../../components/dev-agent/dev-agent-control.tsx";

/**
 * The agent's header actions (dev-agent control + GitHub publish/PR buttons),
 * rendered inline into the main panel header's right cluster.
 *
 * The CMS renderer swaps in here, not inside `HeaderActions`, so the sandbox
 * hooks that renderer mounts (events, lifecycle, publish gate) never mount on a
 * session that has no sandbox.
 *
 * The GitHub cluster is SITE-EDITOR ONLY: branch, working-tree status and
 * publish all describe the surface being edited, and reading them next to a
 * screen that is not it (the project home, Assets) invited the question of what
 * exactly they applied to. The dev-agent control is not part of that cluster —
 * it switches which project you are talking to — so it stays everywhere.
 */
export function VirtualMcpHeaderInfo({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  // The SESSION's runtime, not the project's: a coding session on a CMS-default
  // project gets the sandbox header, and the hooks that header mounts.
  const fastPreviewActive = useSessionRuntime(virtualMcp.id).runtime === "cms";
  const activeTab = useActivePanelTabId();
  const onSiteEditor = !!activeTab && isSurfaceTab(activeTab);

  return (
    <div className="flex items-center gap-2">
      <DevAgentControl virtualMcp={virtualMcp} />
      {onSiteEditor && agentShowsGithubHeaderActions(virtualMcp) ? (
        fastPreviewActive ? (
          <CmsHeaderActions virtualMcpId={virtualMcp.id} />
        ) : (
          <HeaderActions virtualMcpId={virtualMcp.id} />
        )
      ) : null}
    </div>
  );
}
