import type { ReactNode } from "react";
import { Panel } from "@/components/panel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/resizable";
import { ThreadsMenu } from "@/components/chat/threads-menu";
import { NewChatCrumb } from "@/components/header/shell-breadcrumb";
import { useSidePanelWidth } from "@/hooks/use-side-panel-width";
import {
  computeWorkspacePanelSizes,
  type WorkspaceVisibility,
} from "@/hooks/use-layout-state";
import { PanelCollapseToggle } from "@/layouts/agent-shell-layout/toggle-buttons";

const SIDE_PANEL_ID = "workspace-side-panel";
const MAIN_PANEL_ID = "workspace-main-panel";

interface WorkspaceLayoutProps extends WorkspaceVisibility {
  identity: string;
  toggleMain: () => void;
  chatContent: ReactNode;
  children: ReactNode;
}

/** Positions the chat and routed panel. Each panel composes its own topbar and body. */
export function WorkspaceLayout({
  identity,
  sidePanelOpen,
  mainOpen,
  toggleMain,
  chatContent,
  children,
}: WorkspaceLayoutProps) {
  const [sidePanelWidth, setSidePanelWidth] = useSidePanelWidth();
  const sizes = computeWorkspacePanelSizes({ sidePanelOpen, mainOpen });
  const sideSize = sidePanelOpen && mainOpen ? sidePanelWidth : sizes.side;
  const mainSize = 100 - sideSize;

  return (
    <ResizablePanelGroup
      ref={(group) => {
        if (!group) return;
        let attached = true;
        // The library registers the group after attaching its imperative ref.
        queueMicrotask(() => {
          if (attached) {
            group.setLayout({
              [SIDE_PANEL_ID]: sideSize,
              [MAIN_PANEL_ID]: mainSize,
            });
          }
        });
        return () => {
          attached = false;
        };
      }}
      key={identity}
      defaultLayout={{
        [SIDE_PANEL_ID]: sideSize,
        [MAIN_PANEL_ID]: mainSize,
      }}
      orientation="horizontal"
      data-slot="workspace"
      className="flex-1 min-h-0 pt-1 pb-1 pr-1 pl-0 [&>[data-workspace-panel-open]]:!min-w-[320px]"
      style={{ overflow: "visible" }}
      onLayoutChanged={(layout, { isUserInteraction }) => {
        const percentage = layout[SIDE_PANEL_ID];
        if (
          isUserInteraction &&
          sidePanelOpen &&
          mainOpen &&
          typeof percentage === "number" &&
          percentage > 0 &&
          percentage < 100
        ) {
          setSidePanelWidth(percentage);
        }
      }}
    >
      <ResizablePanel
        id={SIDE_PANEL_ID}
        defaultSize="33%"
        minSize="20%"
        collapsible
        collapsedSize="0%"
        data-workspace-panel-open={sidePanelOpen ? "" : undefined}
        className="min-w-0 overflow-hidden bg-sidebar"
      >
        <div className="h-full min-h-0 p-0.5">
          <Panel data-testid="side-panel">
            {sidePanelOpen && (
              <>
                <Panel.Topbar>
                  <Panel.Topbar.Left>
                    <ThreadsMenu />
                  </Panel.Topbar.Left>
                  <Panel.Topbar.Right className="shrink-0">
                    <NewChatCrumb />
                    {!mainOpen && (
                      <PanelCollapseToggle
                        side="right"
                        open={mainOpen}
                        onToggle={toggleMain}
                      />
                    )}
                  </Panel.Topbar.Right>
                </Panel.Topbar>
                <Panel.Content data-testid="chat-panel">
                  {chatContent}
                </Panel.Content>
              </>
            )}
          </Panel>
        </div>
      </ResizablePanel>
      <ResizableHandle className="bg-sidebar" />
      <ResizablePanel
        id={MAIN_PANEL_ID}
        defaultSize="67%"
        minSize="20%"
        collapsible
        collapsedSize="0%"
        data-workspace-panel-open={mainOpen ? "" : undefined}
        className="min-w-0 overflow-hidden bg-sidebar"
      >
        <div className="h-full min-h-0 p-0.5">{children}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
