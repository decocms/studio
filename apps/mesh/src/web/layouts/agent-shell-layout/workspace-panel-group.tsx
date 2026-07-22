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
 * Breakpoints that drive the main header's responsive degradation.
 *
 * Priority as space shrinks (least essential drops first): the page selector
 * goes first, then the 3rd tab, then the 2nd — the right-side actions (Edit /
 * publish) always survive. Two independent measured signals drive this, so it
 * adapts to whatever the right actions actually take (branch selector present
 * or not, i18n label lengths, …) instead of guessing off the whole header:
 *
 *  - `pageSelectorMin` is checked against the *measured free gap* the selector
 *    sits in, so it hides (display:none) the instant that gap can't hold a
 *    usable selector, instead of squishing to a chevron with no label.
 *  - `threeTabs` / `twoTabs` are checked against the *space left of the right
 *    actions* (`headerWidth - rightWidth`), i.e. the room the tab group + gap
 *    actually get. A CSS safety net (the left group is `min-w-0`/overflow-hidden
 *    and shrinks) guarantees the right actions are never clipped even if these
 *    estimates run slightly optimistic — the tab group yields first.
 */
const HEADER_W = {
  pageSelectorMin: 140,
  /** Space left of the right actions to keep 3 labelled tabs before folding. */
  threeTabs: 475,
  /** Space left of the right actions to keep 2 labelled tabs before folding. */
  twoTabs: 340,
} as const;

/**
 * How many view tabs to show given the space to the LEFT of the right actions.
 * `headerWidth`/`rightWidth` are `-1` until measured — treat that as roomy so
 * the header opens fully and only tightens once real measurements land.
 */
function maxTabsForSpace(headerWidth: number, rightWidth: number): number {
  if (headerWidth < 0 || rightWidth < 0) return 3;
  const leftSpace = headerWidth - rightWidth;
  if (leftSpace >= HEADER_W.threeTabs) return 3;
  if (leftSpace >= HEADER_W.twoTabs) return 2;
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

  // Responsive header: measure the whole header (== panel width) and the right
  // actions cluster, so the tab count adapts to the room actually left for it
  // (`headerWidth - rightWidth`), and measure the centered page-selector gap so
  // the selector hides the moment it can't fit — never squished. All three read
  // `-1` until measured, treated as "roomy" so the header opens fully first.
  const [headerWidth, headerRef] = useElementWidth();
  const [rightWidth, rightRef] = useElementWidth();
  const maxTabs = maxTabsForSpace(headerWidth, rightWidth);
  const [pageSelectorSpace, pageSelectorRef] = useElementWidth();
  const showPageSelector =
    pageSelectorSpace < 0 || pageSelectorSpace >= HEADER_W.pageSelectorMin;

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
      {/* min-w-0 + overflow-hidden is the safety net: if the tab count estimate
          runs optimistic, THIS group yields (its trailing tabs clip) so the
          right actions on the far side are never pushed off-screen. */}
      <div className="flex min-w-0 shrink items-center gap-0.5 overflow-hidden">
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
      {/* The page selector centers between the two side groups in this flex-1
          gap. We measure the gap (not the header) and, once it's too tight for
          a usable selector, hide the slot (display:none) rather than let it
          squish. The measured wrapper stays flex-1 so hiding the slot doesn't
          collapse the measurement (no feedback loop); the portal target stays
          mounted so Preview keeps rendering into it instead of falling back to
          its inline toolbar. */}
      <div
        ref={pageSelectorRef}
        className="flex min-w-0 flex-1 items-center justify-center"
      >
        <MainPanelHeaderSlot className={cn(!showPageSelector && "hidden")} />
      </div>
      {/* shrink-0: the right actions (Edit / Submit / Publish / ⋯) are the
          highest-priority controls — they hold their size and are never
          clipped; the selector and tab group yield instead. Measured so the
          tab count knows how much room is actually left for it. */}
      <div
        ref={rightRef}
        className="flex shrink-0 items-center justify-end gap-1"
      >
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
