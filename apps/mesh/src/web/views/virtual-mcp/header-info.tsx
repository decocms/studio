import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { getActiveGithubRepo } from "@/web/lib/github-repo.ts";
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
  const githubRepo = getActiveGithubRepo(virtualMcp);
  if (!githubRepo) return null;

  const actions = <HeaderActions virtualMcpId={virtualMcp.id} />;
  if (inline) return actions;

  return <Toolbar.Right>{actions}</Toolbar.Right>;
}
