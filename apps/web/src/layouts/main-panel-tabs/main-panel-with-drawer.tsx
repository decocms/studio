/**
 * MainPanelWithDrawer — composes the tab body (with its internal per-tab
 * ErrorBoundary) above the sandbox PreviewDrawer.
 *
 * The drawer is mounted whenever the project can have one — a clonable source
 * and a daemon behind it — and sits collapsed to its toolbar until the user
 * expands it (PreviewDrawerHost persists that per virtualMcpId). There is no
 * separate "is the terminal shown" flag: a control that could hide the drawer
 * while the drawer stayed mounted is how the console ended up un-dismissable
 * in CMS mode.
 */

import { useSearch } from "@tanstack/react-router";
import { useChatTask } from "@/components/chat/chat-context";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { MainPanelContent } from "@/layouts/main-panel-tabs";
import { OVERLAY_TABS } from "./tab-id";
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
  /** Thread-scoped repos (bound by `load_repo`) get the drawer too. */
  const hasClonableSource =
    agentHasClonableSource(inset?.entity?.metadata) ||
    agentHasClonableSource(activeTask?.metadata);
  const { cmsModeActive } = useSandboxLifecycle();
  // A sandbox-less branch has no daemon for a terminal to attach to.
  const hasDaemon = !cmsModeActive;
  const showDrawer =
    hasClonableSource &&
    hasDaemon &&
    !(typeof main === "string" && OVERLAY_TABS.has(main));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-hidden">
        <MainPanelContent taskId={taskId} virtualMcpId={virtualMcpId} />
      </div>
      {showDrawer && <PreviewDrawerHost />}
    </div>
  );
}
