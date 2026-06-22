import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { agentShowsGithubHeaderActions } from "@/web/lib/agent-capabilities";
import { HeaderActions } from "../../components/thread/github/header-actions.tsx";
import { Toolbar } from "../../layouts/agent-shell-layout/toolbar.tsx";

export function VirtualMcpHeaderInfo({
  virtualMcp,
  inline = false,
}: {
  virtualMcp: VirtualMCPEntity;
  /** When true, skip the toolbar portal (mobile header has no Toolbar shell). */
  inline?: boolean;
}) {
  if (!agentShowsGithubHeaderActions(virtualMcp)) return null;

  const actions = <HeaderActions virtualMcpId={virtualMcp.id} />;
  if (inline) return actions;

  return <Toolbar.Right>{actions}</Toolbar.Right>;
}
