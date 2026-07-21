import type { VirtualMCPEntity } from "@decocms/studio-sdk/types";
import { agentShowsGithubHeaderActions } from "@/web/lib/agent-capabilities";
import { HeaderActions } from "../../components/thread/github/header-actions.tsx";
import { DevAgentControl } from "../../components/dev-agent/dev-agent-control.tsx";
import { OpenInBoardButton } from "../../components/thread/open-in-board-button.tsx";
import { Toolbar } from "../../layouts/agent-shell-layout/toolbar.tsx";

export function VirtualMcpHeaderInfo({
  virtualMcp,
  inline = false,
}: {
  virtualMcp: VirtualMCPEntity;
  /** When true, skip the toolbar portal (mobile header has no Toolbar shell). */
  inline?: boolean;
}) {
  const content = (
    <div className="flex items-center gap-2">
      <OpenInBoardButton />
      <DevAgentControl virtualMcp={virtualMcp} />
      {agentShowsGithubHeaderActions(virtualMcp) ? (
        <HeaderActions virtualMcpId={virtualMcp.id} />
      ) : null}
    </div>
  );
  if (inline) return content;

  return <Toolbar.Right>{content}</Toolbar.Right>;
}
