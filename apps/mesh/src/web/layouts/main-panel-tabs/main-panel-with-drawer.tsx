/**
 * MainPanelWithDrawer — composes the tab body (with its internal per-tab
 * ErrorBoundary) above the sandbox PreviewDrawer. The drawer is gated on
 * `hasClonableSource` so non-cloneable agents (e.g. decopilot) don't see it.
 */

import { useChatTask } from "@/web/components/chat/chat-context";
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
  const { activeTask } = useChatTask();
  // Thread-scoped repo (bound by `load_repo`) also gets the drawer + dev
  // terminal, not just agents with their own repo.
  const hasClonableSource =
    agentHasClonableSource(inset?.entity?.metadata) ||
    agentHasClonableSource(activeTask?.metadata);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-hidden">
        <MainPanelContent taskId={taskId} virtualMcpId={virtualMcpId} />
      </div>
      {hasClonableSource && <PreviewDrawerHost />}
    </div>
  );
}
