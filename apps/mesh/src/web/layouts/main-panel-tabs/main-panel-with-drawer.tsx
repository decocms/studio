/**
 * MainPanelWithDrawer — composes the tab body (with its internal per-tab
 * ErrorBoundary) above the sandbox PreviewDrawer. The drawer is gated on
 * `hasClonableSource` so non-cloneable agents (e.g. decopilot) don't see it.
 */

import { useInsetContext } from "@/web/layouts/agent-shell-layout";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { MainPanelContent } from "@/web/layouts/main-panel-tabs";
import { PreviewDrawerHost } from "./preview-drawer-host";

export function MainPanelWithDrawer({
  virtualMcpId,
  taskId,
}: {
  virtualMcpId: string;
  taskId: string;
}) {
  const inset = useInsetContext();
  const hasClonableSource = agentHasClonableSource(inset?.entity?.metadata);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-hidden">
        <MainPanelContent taskId={taskId} virtualMcpId={virtualMcpId} />
      </div>
      {hasClonableSource && <PreviewDrawerHost />}
    </div>
  );
}
