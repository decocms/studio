/**
 * MainPanelWithDrawer — composes the tab body (with its internal per-tab
 * ErrorBoundary) above the sandbox PreviewDrawer. The drawer is gated on
 * `hasClonableSource` so non-cloneable agents (e.g. decopilot) don't see it.
 */

import { useSearch } from "@tanstack/react-router";
import { useChatTask } from "@/components/chat/chat-context";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { resolveCmsMode } from "@/sdk/cms-mode";
import { MainPanelContent } from "@/layouts/main-panel-tabs";
import { OVERLAY_TABS } from "./tab-id";
import { PreviewDrawerHost } from "./preview-drawer-host";
import {
  TerminalVisibilityProvider,
  useTerminalVisibility,
} from "./terminal-visibility";

// Renders the bottom terminal drawer only when the user has toggled it on
// (via the preview's ⋯ menu). Separate component so it can consume the
// visibility context that MainPanelWithDrawer provides.
function TerminalDrawerSlot() {
  const terminal = useTerminalVisibility();
  if (!terminal?.visible) return null;
  return <PreviewDrawerHost />;
}

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
  const showDrawer =
    hasClonableSource && !(typeof main === "string" && OVERLAY_TABS.has(main));
  // CMS mode is sandbox-less — there is no daemon for a terminal to attach to.
  const terminalAvailable = !resolveCmsMode(inset?.entity?.metadata).active;

  return (
    <TerminalVisibilityProvider
      virtualMcpId={virtualMcpId}
      available={terminalAvailable}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex-1 min-h-0 overflow-hidden">
          <MainPanelContent taskId={taskId} virtualMcpId={virtualMcpId} />
        </div>
        {showDrawer && <TerminalDrawerSlot />}
      </div>
    </TerminalVisibilityProvider>
  );
}
