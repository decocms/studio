/**
 * Persistent desktop workspace: SidePanel | MainPanel.
 *
 * Each panel is one full-height card that owns its own 48px header (see
 * PanelHeader), and a PanelCollapseToggle pair brackets the workspace — so
 * controls stay with their own panel instead of relocating when a panel hides.
 */

import {
  useEffect,
  useRef,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type GroupImperativeHandle,
} from "@/components/resizable";
import { useSidePanelWidth } from "@/hooks/use-side-panel-width";
import { useElementWidth } from "@/hooks/use-element-width";
import {
  computeWorkspacePanelSizes,
  type SidePanelKind,
  type WorkspaceVisibility,
} from "@/hooks/use-layout-state";
import { MainPanelWithDrawer } from "@/layouts/main-panel-tabs/main-panel-with-drawer";
import { MainPanelTabsBar } from "@/layouts/main-panel-tabs/main-panel-tabs-bar";
import { CmsTour } from "@/components/cms-tour/cms-tour";
import { headerLayout } from "./header-layout";
import { VirtualMcpHeaderInfo } from "@/views/virtual-mcp/header-info";
import { ChatModeRow } from "@/components/chat/pills/chat-mode-row";
import { useOptionalChatTask } from "@/components/chat/context";
import { NewChatCrumb } from "@/components/header/shell-breadcrumb";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ThreadsMenu } from "@/components/chat/threads-menu";
import { SidePanel } from "./side-panel";
import { PanelCollapseToggle } from "./toggle-buttons";
import {
  MainPanelHeaderEndSlot,
  MainPanelHeaderProvider,
  MainPanelHeaderSlot,
  PanelHeader,
} from "./panel-header";

const SIDE_PANEL_ID = "workspace-side-panel";
const MAIN_PANEL_ID = "workspace-main-panel";

/**
 * One panel column: a rounded card that runs the full height of the column and
 * owns its own top bar, so both panels read as one identical surface.
 *
 * translateZ(0) promotes the card to its own layer so the Preview iframe clips
 * to the rounded corners (iframes ignore border-radius clipping otherwise,
 * leaving square corners).
 */
function PanelCard({
  children,
  header,
  testId,
}: PropsWithChildren<{
  header?: ReactNode;
  testId: string;
}>) {
  const card =
    "min-h-0 flex-1 overflow-hidden rounded-[0.75rem] bg-background card-shadow [transform:translateZ(0)]";

  return (
    <div className="flex h-full min-h-0 flex-col p-0.5">
      <div data-testid={testId} className={cn(card, "flex flex-col")}>
        {header}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

/**
 * The agent's main-panel controls: the view tab bar, which also folds in the
 * agent-independent overlays (Library / Tasks) and caps itself at 3 buttons
 * plus a stack popover. Rendered in whichever header hosts the main panel.
 */
function MainControls({
  virtualMcpId,
  taskId,
  disableActiveMainToggle,
  maxVisible,
}: {
  virtualMcpId: string;
  taskId: string;
  disableActiveMainToggle: boolean;
  maxVisible?: number;
}) {
  return (
    <MainPanelTabsBar
      virtualMcpId={virtualMcpId}
      taskId={taskId}
      disableActiveMainToggle={disableActiveMainToggle}
      maxVisible={maxVisible}
    />
  );
}

export interface WorkspacePanelGroupProps extends WorkspaceVisibility {
  virtualMcpId: string;
  taskId: string;
  entity: VirtualMCPEntity;
  toggleSidePanel: (sidePanel: SidePanelKind) => void;
  toggleMain: () => void;
  chatContent?: ReactNode;
}

export function WorkspacePanelGroup({
  virtualMcpId,
  taskId,
  entity,
  sidePanel,
  mainOpen,
  toggleSidePanel,
  toggleMain,
  chatContent,
}: WorkspacePanelGroupProps) {
  const [sidePanelWidth, setSidePanelWidth] = useSidePanelWidth();
  const panelGroupRef = useRef<GroupImperativeHandle>(null);
  const visibility = { sidePanel, mainOpen };
  const sizes = computeWorkspacePanelSizes(visibility);
  const sideSize = sidePanel !== null && mainOpen ? sidePanelWidth : sizes.side;
  const mainSize = 100 - sideSize;

  const chatOpen = sidePanel !== null;

  // Responsive header: measure the whole header (== panel width) and the right
  // actions cluster. `headerLayout` derives BOTH the tab count and whether the
  // center page selector shows from that single stable pair — never from the
  // center gap, which grows when a tab folds and used to flicker the selector
  // back. Widths read `-1` until measured, treated as "roomy" so the header
  // opens fully first.
  const [headerWidth, headerRef] = useElementWidth();
  const [rightWidth, rightRef] = useElementWidth();
  const { maxTabs } = headerLayout(headerWidth, rightWidth);

  // The thread list and new-chat action live in the chat panel header.
  const newChatCrumb = <NewChatCrumb />;
  const threadsMenu = <ThreadsMenu />;

  const publishActions = <VirtualMcpHeaderInfo virtualMcp={entity} />;

  // Branch selector lives in the workspace header (top-right, next to publish),
  // NOT in the chat composer — it's a workspace-level concern (which branch the
  // sandbox/preview runs on), shared by chat and preview alike. Renders null for
  // agents without a connected GitHub repo. Reads the branch from the task
  // context (this tree is inside Chat.ActiveTaskProvider).
  const currentBranch = useOptionalChatTask()?.currentBranch ?? null;
  const branchSelector = (
    <ChatModeRow virtualMcp={entity} currentBranch={currentBranch} />
  );

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- syncs URL-derived visibility with the resizable panels' imperative layout API
  useEffect(() => {
    panelGroupRef.current?.setLayout({
      [SIDE_PANEL_ID]: sideSize,
      [MAIN_PANEL_ID]: mainSize,
    });
  }, [sideSize, mainSize]);

  const chatHeader = (
    <PanelHeader>
      {threadsMenu}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {newChatCrumb}
        {/* The main panel's own toggle relocates here once its header is gone. */}
        {!mainOpen && (
          <PanelCollapseToggle
            side="right"
            open={mainOpen}
            disabled={!chatOpen}
            onToggle={toggleMain}
          />
        )}
      </div>
    </PanelHeader>
  );

  // Three content-sized zones spaced with justify-between: tabs left, publish
  // right, and Preview's page selector sitting with EQUAL whitespace on either
  // side (equidistant between the two groups — not pinned to the absolute bar
  // center, which looks lopsided when the tab group is wider than the publish
  // group). When the selector slot is empty (non-Preview views), the publish
  // actions still land far right.
  const mainHeader = (
    <PanelHeader ref={headerRef} className="justify-between gap-2">
      {/* min-w-0 + overflow-hidden is the safety net: if the tab count estimate
          runs optimistic, THIS group yields (its trailing tabs clip) so the
          right actions on the far side are never pushed off-screen. */}
      <div className="flex min-w-0 shrink items-center gap-0.5 overflow-hidden">
        <PanelCollapseToggle
          side="left"
          open={chatOpen}
          disabled={!mainOpen}
          onToggle={() => toggleSidePanel("chat")}
        />
        <MainControls
          virtualMcpId={virtualMcpId}
          taskId={taskId}
          disableActiveMainToggle={!chatOpen}
          maxVisible={maxTabs}
        />
      </div>
      {/* The page selector centers between the two side groups in this flex-1
          gap. It hides below 384px of PANEL HEADER — a container query on
          `@container/panel-header`, not this flex gap (which grows when a tab
          folds and used to flicker the selector back) and not the viewport
          (one panel is far narrower than the screen). It goes AFTER the tab
          labels collapse, so shedding those buys the selector its room first.
          The portal target stays mounted so Preview keeps rendering into it
          instead of falling back to its inline toolbar.

          384px is set by the group's measured floor: its min-content is 112px
          (36 CMS + 28 refresh + 24 page chevron + 28 open-in-new-tab), and a
          header that size leaves ~112-128px once the left group (66px — the
          tab budget is down to one tab this narrow) and the actions (178px)
          take their share. One breakpoint lower and the icons clip. Note the
          query measures the CONTENT box, so with `px-1.5` this fires around
          396px of rendered width — a ~16px margin above the floor, not on it.

          Deliberately far later than the old JS rule (~668px). The trade: the
          page NAME is gone from ~448px down — the selector is a bare chevron
          there — so 384-448px is four usable icons without a label. Losing the
          controls outright was judged worse than losing the label. */}
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <MainPanelHeaderSlot className="@max-sm/panel-header:hidden" />
      </div>
      {/* Right side. The wrapper is shrinkable so the branch selector inside it
          can yield BEFORE the centered address bar (which is `flex-1` — basis 0,
          so it shrinks last). The branch sits in its own `min-w-0` slot and
          truncates first; the actions cluster stays `shrink-0` (Edit / Submit /
          Publish / ⋯ never clip) and is what `rightRef` measures, so the tab
          count budget is unaffected by the branch label's width. */}
      <div className="flex min-w-0 shrink items-center justify-end gap-1">
        <div className="flex min-w-0 shrink items-center justify-end">
          {branchSelector}
        </div>
        <div
          ref={rightRef}
          className="flex shrink-0 items-center justify-end gap-1"
        >
          <MainPanelHeaderEndSlot />
          {publishActions}
          <PanelCollapseToggle
            side="right"
            open={mainOpen}
            disabled={!chatOpen}
            onToggle={toggleMain}
          />
        </div>
      </div>
    </PanelHeader>
  );

  return (
    <MainPanelHeaderProvider>
      <CmsTour virtualMcpId={virtualMcpId} />
      <ResizablePanelGroup
        ref={panelGroupRef}
        key={`${virtualMcpId}-${taskId}`}
        orientation="horizontal"
        className={cn(
          // Full-height cards need the same room above as below.
          "flex-1 min-h-0 pt-1 pb-1 pr-1 pl-0 [&>[data-workspace-panel-open]]:!min-w-[320px]",
        )}
        style={{ overflow: "visible" }}
        onLayoutChanged={(layout, { isUserInteraction }) => {
          const percentage = layout[SIDE_PANEL_ID];
          if (
            isUserInteraction &&
            sidePanel !== null &&
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
          defaultSize={`${sizes.side}%`}
          minSize="20%"
          collapsible
          collapsedSize="0%"
          data-workspace-panel-open={sidePanel !== null ? "" : undefined}
          className="min-w-0 overflow-hidden bg-sidebar"
        >
          <PanelCard testId="side-panel" header={chatOpen ? chatHeader : null}>
            {chatOpen && <SidePanel chatContent={chatContent} />}
          </PanelCard>
        </ResizablePanel>

        <ResizableHandle className="bg-sidebar" />

        <ResizablePanel
          id={MAIN_PANEL_ID}
          defaultSize={`${sizes.main}%`}
          minSize="20%"
          collapsible
          collapsedSize="0%"
          data-workspace-panel-open={mainOpen ? "" : undefined}
          className="min-w-0 overflow-hidden bg-sidebar"
        >
          <PanelCard testId="main-panel" header={mainOpen ? mainHeader : null}>
            <MainPanelWithDrawer taskId={taskId} virtualMcpId={virtualMcpId} />
          </PanelCard>
        </ResizablePanel>
      </ResizablePanelGroup>
    </MainPanelHeaderProvider>
  );
}
