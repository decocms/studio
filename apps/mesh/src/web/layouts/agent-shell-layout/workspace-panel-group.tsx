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
import { CmsTour } from "@/web/components/cms-tour/cms-tour";
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
 * Space budget (px) that drives the main header's responsive degradation.
 *
 * The header lays out as: [left group: chat + view tabs + tab-overflow] · [center:
 * Preview's page selector] · [right actions: Edit / branch / ⋯ / publish]. As the
 * panel narrows, controls drop in this exact order — 3rd tab, then 2nd tab, then
 * the whole center — and NEVER reappear (see `headerLayout`). The right actions
 * always survive.
 *
 * Both decisions are computed from ONE pair of stable measurements — the header
 * width and the right-actions width — so nothing depends on the center gap (which
 * grows when a tab folds and previously made the selector flicker back). `avail =
 * headerWidth - rightWidth` is the room the left group + center actually share.
 */
const HEADER_W = {
  /** Left prefix that's always there: chat toggle + tab-overflow menu + gaps. */
  lead: 70,
  /** One labelled view tab. */
  tab: 132,
  /**
   * Room the center (Preview's page selector) needs before it's shown at all —
   * generous enough that when it DOES show it reads its page name instead of
   * squishing to a bare chevron. Below this it's hidden (display:none), not
   * shrunk.
   */
  middle: 232,
} as const;

/**
 * Given the header width and the measured right-actions width, decide how many
 * view tabs to show (rest fold into the ⋯ menu) and whether the center page
 * selector shows. Both are a monotonic function of `avail = headerWidth -
 * rightWidth`, so shrinking only ever drops controls (never brings one back).
 * Widths are `-1` until measured — treat that as roomy so the header opens fully
 * and only tightens once real measurements land.
 *
 * A CSS safety net (the left group is `min-w-0`/overflow-hidden and shrinks)
 * guarantees the right actions are never clipped even if these estimates run
 * slightly optimistic — the tab group yields first.
 */
function headerLayout(
  headerWidth: number,
  rightWidth: number,
): { maxTabs: number; showPageSelector: boolean } {
  if (headerWidth < 0 || rightWidth < 0) {
    return { maxTabs: 3, showPageSelector: true };
  }
  const avail = headerWidth - rightWidth;
  const { lead, tab, middle } = HEADER_W;
  if (avail >= lead + 3 * tab + middle)
    return { maxTabs: 3, showPageSelector: true };
  if (avail >= lead + 2 * tab + middle)
    return { maxTabs: 2, showPageSelector: true };
  if (avail >= lead + 1 * tab + middle)
    return { maxTabs: 1, showPageSelector: true };
  return { maxTabs: 1, showPageSelector: false };
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
  // actions cluster. `headerLayout` derives BOTH the tab count and whether the
  // center page selector shows from that single stable pair — never from the
  // center gap, which grows when a tab folds and used to flicker the selector
  // back. Widths read `-1` until measured, treated as "roomy" so the header
  // opens fully first.
  const [headerWidth, headerRef] = useElementWidth();
  const [rightWidth, rightRef] = useElementWidth();
  const { maxTabs, showPageSelector } = headerLayout(headerWidth, rightWidth);

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
          gap. `headerLayout` decides its visibility from the header/right widths
          (not this gap), so it never flickers back when a tab folds; below the
          threshold the slot is hidden (display:none) rather than squished. The
          portal target stays mounted so Preview keeps rendering into it instead
          of falling back to its inline toolbar. */}
      <div className="flex min-w-0 flex-1 items-center justify-center">
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
      <CmsTour virtualMcpId={virtualMcpId} />
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
