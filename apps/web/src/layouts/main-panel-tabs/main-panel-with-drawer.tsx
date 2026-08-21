/**
 * MainPanelWithDrawer — composes the tab body (with its internal per-tab
 * ErrorBoundary) above the sandbox PreviewDrawer, which `shouldShowTerminalDrawer` gates.
 */

import { useSearch } from "@tanstack/react-router";
import { useChatTask } from "@/components/chat/chat-context";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { MainPanelContent } from "@/layouts/main-panel-tabs";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { shouldShowTerminalDrawer } from "./terminal-drawer-gate";
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
  const { main } = useSearch({ strict: false }) as { main?: string | 0 };
  // Thread-scoped repo (bound by `load_repo`) also gets the drawer + dev
  // terminal, not just agents with their own repo.
  const hasClonableSource =
    agentHasClonableSource(inset?.entity?.metadata) ||
    agentHasClonableSource(activeTask?.metadata);
  // The one thread-aware gate, scoped to this agent's entity by the id match.
  const sessionRuntime = useSessionRuntime(inset?.entity?.id).runtime;
  const fastPreviewActive =
    inset?.entity?.id === virtualMcpId && sessionRuntime === "cms";
  const showDrawer = shouldShowTerminalDrawer({
    hasClonableSource,
    fastPreviewActive,
    mainTab: typeof main === "string" ? main : null,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-hidden">
        <MainPanelContent taskId={taskId} virtualMcpId={virtualMcpId} />
      </div>
      {showDrawer && <PreviewDrawerHost />}
    </div>
  );
}
