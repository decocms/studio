/**
 * Persistent desktop workspace: SidePanel | MainPanel.
 *
 * Each panel owns a 48px header (see PanelHeader). The buttons follow their
 * panel: the Chat toggle lives in the chat header while chat is open and moves
 * into the main header when chat is closed; the main view tabs + publish live
 * in the main header while it's open and move into the chat header when the
 * main panel is closed. So a control never vanishes just because its home panel
 * is hidden.
 */

import {
  useEffect,
  useRef,
  useTransition,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { cn } from "@deco/ui/lib/utils.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ImperativePanelGroupHandle,
} from "@/web/components/resizable";
import { useSidePanelWidth } from "@/web/hooks/use-side-panel-width";
import { useElementWidth } from "@/web/hooks/use-element-width";
import {
  computeWorkspacePanelSizes,
  type SidePanelKind,
  type WorkspaceVisibility,
} from "@/web/hooks/use-layout-state";
import { MainPanelWithDrawer } from "@/web/layouts/main-panel-tabs/main-panel-with-drawer";
import { MainPanelTabsBar } from "@/web/layouts/main-panel-tabs/main-panel-tabs-bar";
import { VirtualMcpHeaderInfo } from "@/web/views/virtual-mcp/header-info";
import { ChatModeRow } from "@/web/components/chat/pills/chat-mode-row";
import { useOptionalChatTask } from "@/web/components/chat/context";
import {
  AgentSwitcherCrumb,
  NewChatCrumb,
} from "@/web/components/header/shell-breadcrumb";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import { SidePanel } from "./side-panel";
import { ChatToggle } from "./toggle-buttons";
import {
  MainPanelHeaderEndSlot,
  MainPanelHeaderProvider,
  MainPanelHeaderSlot,
  PanelHeader,
} from "./panel-header";

function PanelCard({
  children,
  header,
  testId,
}: PropsWithChildren<{ header?: ReactNode; testId: string }>) {
  // The header sits ABOVE the card, on the sidebar background — not inside the
  // rounded card. Each column reads as a top bar + a card below it.
  return (
    <div className="flex h-full min-h-0 flex-col p-0.5 pt-0.25">
      {header}
      <div
        data-testid={testId}
        // translateZ(0) promotes the card to its own layer so the Preview
        // iframe clips to the rounded corners (iframes ignore border-radius
        // clipping otherwise, leaving square corners).
        className="min-h-0 flex-1 overflow-hidden rounded-[0.75rem] bg-background card-shadow [transform:translateZ(0)]"
      >
        {children}
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

/**
 * Header-width breakpoints that drive the main header's responsive degradation.
 * The header is always the panel's full width, so these read as panel widths
 * and there's no measure→layout→measure feedback loop.
 *
 * Priority as space shrinks (least essential drops first): the page selector
 * goes first, then the 3rd tab, then the 2nd — Preview + the right-side actions
 * always survive. Numbers are generous so the surviving controls never overlap;
 * tune here if the thresholds feel early/late.
 */
const HEADER_W = {
  /** Page selector shown at/above this width; hidden (not squished) below. */
  pageSelector: 680,
  /** Third tab kept at/above this width. */
  threeTabs: 560,
  /** Second tab kept at/above this width; below it only the active tab shows. */
  twoTabs: 440,
} as const;

function maxTabsForWidth(width: number): number {
  if (width === 0 || width >= HEADER_W.threeTabs) return 3;
  if (width >= HEADER_W.twoTabs) return 2;
  return 1;
}

export interface WorkspacePanelGroupProps extends WorkspaceVisibility {
  virtualMcpId: string;
  taskId: string;
  entity: VirtualMCPEntity;
  toggleSidePanel: (sidePanel: SidePanelKind) => void;
  chatContent?: ReactNode;
}

export function WorkspacePanelGroup({
  virtualMcpId,
  taskId,
  entity,
  sidePanel,
  mainOpen,
  toggleSidePanel,
  chatContent,
}: WorkspacePanelGroupProps) {
  const [_isPending, startTransition] = useTransition();
  const [sidePanelWidth, setSidePanelWidth] = useSidePanelWidth();
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const visibility = { sidePanel, mainOpen };
  const sizes = computeWorkspacePanelSizes(visibility);
  const sideSize = sidePanel !== null && mainOpen ? sidePanelWidth : sizes.side;
  const mainSize = 100 - sideSize;

  const chatOpen = sidePanel !== null;
  // When the main panel is hidden but chat is open, its controls (view tabs +
  // publish) move into the chat header so views are still reachable.
  const mainControlsInChat = chatOpen && !mainOpen;

  // Measure the main header (== panel width) so the tab bar and page selector
  // degrade with available space instead of squishing or overflowing. Width is
  // 0 until the first measurement lands; `maxTabsForWidth`/`showPageSelector`
  // both treat 0 as "roomy" so the header opens fully and only tightens if the
  // measurement says it must — no collapsed first-paint flash.
  const [headerWidth, headerRef] = useElementWidth();
  const maxTabs = maxTabsForWidth(headerWidth);
  const showPageSelector =
    headerWidth === 0 || headerWidth >= HEADER_W.pageSelector;

  // The agent switcher + new-chat action live in the nav sidebar while it's
  // expanded. When the sidebar is collapsed it has no room for them, so we
  // surface them in the panel header: the agent switcher sits by the Chat
  // button (left), the new-chat action anchors to the right.
  const { state: sidebarState } = useSidebar();
  const sidebarCollapsed = sidebarState === "collapsed";
  const agentCrumb = sidebarCollapsed ? <AgentSwitcherCrumb /> : null;
  const newChatCrumb = sidebarCollapsed ? <NewChatCrumb /> : null;

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
    panelGroupRef.current?.setLayout([sideSize, mainSize]);
  }, [sideSize, mainSize]);

  const chatHeader = (
    <PanelHeader>
      {agentCrumb}
      <ChatToggle
        sidePanel={sidePanel}
        toggleSidePanel={toggleSidePanel}
        disableActiveSidePanelToggle={!mainOpen}
      />
      {mainControlsInChat && (
        <MainControls
          virtualMcpId={virtualMcpId}
          taskId={taskId}
          disableActiveMainToggle
        />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {mainControlsInChat && branchSelector}
        {mainControlsInChat && publishActions}
        {newChatCrumb}
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
      <div className="flex shrink-0 items-center gap-0.5">
        {!chatOpen && agentCrumb}
        {!chatOpen && (
          <ChatToggle sidePanel={sidePanel} toggleSidePanel={toggleSidePanel} />
        )}
        <MainControls
          virtualMcpId={virtualMcpId}
          taskId={taskId}
          disableActiveMainToggle={!chatOpen}
          maxVisible={maxTabs}
        />
      </div>
      {/* The page selector centers between the two side groups. Below the
          `pageSelector` breakpoint it's hidden (display:none) rather than
          squished — the portal target stays mounted so Preview keeps rendering
          into it and never falls back to its inline toolbar. */}
      <MainPanelHeaderSlot
        className={cn(
          "min-w-0 flex-1 justify-center",
          !showPageSelector && "hidden",
        )}
      />
      {/* shrink-0: the right actions (Edit / Submit / Publish / ⋯) are the
          highest-priority controls — they hold their size so they never
          overlap the center selector; the selector yields instead. */}
      <div className="flex shrink-0 items-center justify-end gap-1">
        {!chatOpen && newChatCrumb}
        {branchSelector}
        <MainPanelHeaderEndSlot />
        {publishActions}
      </div>
    </PanelHeader>
  );

  return (
    <MainPanelHeaderProvider>
      <ResizablePanelGroup
        ref={panelGroupRef}
        key={`${virtualMcpId}-${taskId}`}
        direction="horizontal"
        className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0"
        style={{ overflow: "visible" }}
      >
        <ResizablePanel
          order={1}
          defaultSize={sizes.side}
          minSize={20}
          collapsible
          collapsedSize={0}
          className={cn(
            "overflow-hidden bg-sidebar",
            sidePanel !== null ? "min-w-[320px]" : "min-w-0",
          )}
          onResize={(size) =>
            startTransition(() => {
              if (sidePanel !== null && mainOpen && size > 0 && size < 100) {
                setSidePanelWidth(size);
              }
            })
          }
        >
          <PanelCard testId="side-panel" header={chatOpen ? chatHeader : null}>
            {chatOpen && <SidePanel chatContent={chatContent} />}
          </PanelCard>
        </ResizablePanel>

        <ResizableHandle className="bg-sidebar" />

        <ResizablePanel
          order={2}
          defaultSize={sizes.main}
          minSize={20}
          collapsible
          collapsedSize={0}
          className={cn(
            "min-w-0 overflow-hidden bg-sidebar",
            mainOpen ? "min-w-[320px]" : "min-w-0",
          )}
        >
          <PanelCard testId="main-panel" header={mainOpen ? mainHeader : null}>
            <MainPanelWithDrawer taskId={taskId} virtualMcpId={virtualMcpId} />
          </PanelCard>
        </ResizablePanel>
      </ResizablePanelGroup>
    </MainPanelHeaderProvider>
  );
}
