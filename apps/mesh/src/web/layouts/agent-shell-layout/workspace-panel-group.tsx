/** Persistent desktop workspace: Side panel (Chat | Blocks) | Main. */

import {
  useEffect,
  useRef,
  useTransition,
  type PropsWithChildren,
} from "react";
import { cn } from "@deco/ui/lib/utils.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ImperativePanelGroupHandle,
} from "@/web/components/resizable";
import { BlocksPanel } from "@/web/components/sandbox/blocks/blocks-panel";
import { ChatPanel } from "@/web/components/chat/side-panel-chat";
import { useSidePanelWidth } from "@/web/hooks/use-side-panel-width";
import {
  computeWorkspacePanelSizes,
  type WorkspaceVisibility,
} from "@/web/hooks/use-layout-state";
import { MainPanelWithDrawer } from "@/web/layouts/main-panel-tabs/main-panel-with-drawer";

/**
 * Chat needs room to read; Blocks is a 240px list plus its props editor, so it
 * floors higher. Both stay under `768px - main's 320px` so the narrowest
 * desktop still lays out — the real breathing room comes from the per-tab
 * default width (DEFAULT_SIDE_PANEL_WIDTH), not from these floors.
 */
const SIDE_PANEL_MIN_WIDTH_CLASS = {
  chat: "min-w-[348px]",
  blocks: "min-w-[440px]",
} as const;

function PanelCard({
  children,
  testId,
  hidden,
}: PropsWithChildren<{ testId: string; hidden?: boolean }>) {
  return (
    <div className={cn("h-full p-0.5 pt-0.25", hidden && "hidden")}>
      <div
        data-testid={testId}
        className="h-full min-h-0 overflow-hidden rounded-[0.75rem] bg-background card-shadow"
      >
        {children}
      </div>
    </div>
  );
}

export interface WorkspacePanelGroupProps extends WorkspaceVisibility {
  virtualMcpId: string;
  taskId: string;
  chatContent?: React.ReactNode;
}

export function WorkspacePanelGroup({
  virtualMcpId,
  taskId,
  sidePanel,
  mainOpen,
  chatContent,
}: WorkspacePanelGroupProps) {
  const [_isPending, startTransition] = useTransition();
  // Collapsed: the width is unused, but the tab still keys which stored width
  // to restore when the panel reopens.
  const [sidePanelWidth, setSidePanelWidth] = useSidePanelWidth(
    sidePanel ?? "chat",
  );
  const groupRef = useRef<ImperativePanelGroupHandle>(null);
  const sizes = computeWorkspacePanelSizes({ sidePanel, mainOpen });
  const sideSize = sidePanel && mainOpen ? sidePanelWidth : sizes.sidePanel;
  const mainSize = 100 - sideSize;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- syncs URL-derived visibility with the resizable panels' imperative layout API
  useEffect(() => {
    groupRef.current?.setLayout([sideSize, mainSize]);
  }, [sideSize, mainSize]);

  return (
    <ResizablePanelGroup
      ref={groupRef}
      key={`${virtualMcpId}-${taskId}`}
      direction="horizontal"
      className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0"
      style={{ overflow: "visible" }}
    >
      <ResizablePanel
        order={1}
        defaultSize={sizes.sidePanel}
        minSize={20}
        collapsible
        collapsedSize={0}
        className={cn(
          "overflow-hidden bg-sidebar",
          sidePanel ? SIDE_PANEL_MIN_WIDTH_CLASS[sidePanel] : "min-w-0",
        )}
        onResize={(size) =>
          startTransition(() => {
            if (sidePanel && mainOpen && size > 0 && size < 100) {
              setSidePanelWidth(size);
            }
          })
        }
      >
        {/* Both surfaces stay mounted and swap by visibility: switching to chat
            to ask a question must not discard unsaved block edits or the
            chat's scroll position. */}
        <PanelCard testId="chat-panel" hidden={sidePanel !== "chat"}>
          {chatContent ?? <ChatPanel />}
        </PanelCard>
        <PanelCard testId="blocks-panel-shell" hidden={sidePanel !== "blocks"}>
          <BlocksPanel virtualMcpId={virtualMcpId} />
        </PanelCard>
      </ResizablePanel>

      <ResizableHandle className="bg-sidebar" />

      <ResizablePanel
        order={2}
        defaultSize={sizes.main}
        minSize={25}
        collapsible
        collapsedSize={0}
        className={cn(
          "min-w-0 overflow-hidden bg-sidebar",
          mainOpen ? "min-w-[320px]" : "min-w-0",
        )}
        style={{ overflow: "visible" }}
      >
        <PanelCard testId="main-panel">
          <MainPanelWithDrawer taskId={taskId} virtualMcpId={virtualMcpId} />
        </PanelCard>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
