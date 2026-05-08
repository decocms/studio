import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { HeaderActions } from "../../components/thread/github/header-actions.tsx";
import { Toolbar } from "../../layouts/agent-shell-layout/toolbar.tsx";

export function VirtualMcpHeaderInfo({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  const githubRepo = virtualMcp.metadata?.githubRepo ?? null;
  const showActions = !!githubRepo?.connectionId;

  if (!showActions) return null;

  return (
    <Toolbar.Right>
      <HeaderActions virtualMcpId={virtualMcp.id} />
    </Toolbar.Right>
  );
}
