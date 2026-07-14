/** Persistent desktop workspace: Chat | Blocks | Main. */

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
import { useBlocksPanelWidth } from "@/web/hooks/use-blocks-panel-width";
import { useChatPanelWidth } from "@/web/hooks/use-chat-panel-width";
import {
  computeWorkspacePanelSizes,
  type WorkspaceVisibility,
} from "@/web/hooks/use-layout-state";
import { MainPanelWithDrawer } from "@/web/layouts/main-panel-tabs/main-panel-with-drawer";

function PanelCard({
  children,
  testId,
}: PropsWithChildren<{ testId: string }>) {
  return (
    <div className="h-full p-0.5 pt-0.25">
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
  chatOpen,
  blocksOpen,
  mainOpen,
  chatContent,
}: WorkspacePanelGroupProps) {
  const [_isPending, startTransition] = useTransition();
  const [chatPanelWidth, setChatPanelWidth] = useChatPanelWidth();
  const [blocksPanelWidth, setBlocksPanelWidth] = useBlocksPanelWidth();
  const outerRef = useRef<ImperativePanelGroupHandle>(null);
  const innerRef = useRef<ImperativePanelGroupHandle>(null);
  const visibility = { chatOpen, blocksOpen, mainOpen };
  const sizes = computeWorkspacePanelSizes(visibility);
  const workspaceOpen = blocksOpen || mainOpen;
  const outerChatSize = chatOpen && workspaceOpen ? chatPanelWidth : sizes.chat;
  const outerWorkspaceSize = 100 - outerChatSize;
  const innerBlocksSize =
    blocksOpen && mainOpen
      ? blocksPanelWidth
      : blocksOpen
        ? 100
        : mainOpen
          ? 0
          : 100;
  const innerMainSize = 100 - innerBlocksSize;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- syncs URL-derived visibility with the resizable panels' imperative layout API
  useEffect(() => {
    outerRef.current?.setLayout([outerChatSize, outerWorkspaceSize]);
  }, [outerChatSize, outerWorkspaceSize]);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- syncs URL-derived visibility with the nested Blocks/Main panel group
  useEffect(() => {
    innerRef.current?.setLayout([innerBlocksSize, innerMainSize]);
  }, [innerBlocksSize, innerMainSize]);

  return (
    <ResizablePanelGroup
      ref={outerRef}
      key={`${virtualMcpId}-${taskId}`}
      direction="horizontal"
      className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0"
      style={{ overflow: "visible" }}
    >
      <ResizablePanel
        order={1}
        defaultSize={sizes.chat}
        minSize={20}
        collapsible
        collapsedSize={0}
        className={cn(
          "overflow-hidden bg-sidebar",
          chatOpen ? "min-w-[348px]" : "min-w-0",
        )}
        onResize={(size) =>
          startTransition(() => {
            if (chatOpen && workspaceOpen && size > 0 && size < 100) {
              setChatPanelWidth(size);
            }
          })
        }
      >
        <PanelCard testId="chat-panel">
          {chatContent ?? <ChatPanel />}
        </PanelCard>
      </ResizablePanel>

      <ResizableHandle className="bg-sidebar" />

      <ResizablePanel
        order={2}
        defaultSize={sizes.blocks + sizes.main}
        minSize={20}
        collapsible
        collapsedSize={0}
        className="min-w-0 overflow-hidden"
        style={{ overflow: "visible" }}
      >
        <ResizablePanelGroup
          ref={innerRef}
          direction="horizontal"
          className="h-full min-h-0"
          style={{ overflow: "visible" }}
        >
          <ResizablePanel
            order={1}
            defaultSize={
              sizes.blocks + sizes.main > 0
                ? (sizes.blocks / (sizes.blocks + sizes.main)) * 100
                : 100
            }
            minSize={25}
            collapsible
            collapsedSize={0}
            className={cn(
              "overflow-hidden bg-sidebar",
              blocksOpen ? "min-w-[320px]" : "min-w-0",
            )}
            onResize={(size) =>
              startTransition(() => {
                if (blocksOpen && mainOpen && size > 0 && size < 100) {
                  setBlocksPanelWidth(size);
                }
              })
            }
          >
            <PanelCard testId="blocks-panel-shell">
              <BlocksPanel virtualMcpId={virtualMcpId} />
            </PanelCard>
          </ResizablePanel>

          <ResizableHandle className="bg-sidebar" />

          <ResizablePanel
            order={2}
            defaultSize={
              sizes.blocks + sizes.main > 0
                ? (sizes.main / (sizes.blocks + sizes.main)) * 100
                : 0
            }
            minSize={25}
            collapsible
            collapsedSize={0}
            className={cn(
              "min-w-0 overflow-hidden bg-sidebar",
              mainOpen ? "min-w-[320px]" : "min-w-0",
            )}
          >
            <PanelCard testId="main-panel">
              <MainPanelWithDrawer
                taskId={taskId}
                virtualMcpId={virtualMcpId}
              />
            </PanelCard>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
