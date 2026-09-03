/**
 * Persistent desktop workspace: SidePanel | MainPanel.
 *
 * Each panel is one full-height card. Chat owns a `PanelHeader`; every routed
 * Main surface owns its own `Main.Topbar`. A PanelCollapseToggle pair brackets
 * the workspace so controls stay with their panel when its sibling hides.
 */

import {
  useEffect,
  useRef,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type GroupImperativeHandle,
} from "@/components/resizable";
import { useSidePanelWidth } from "@/hooks/use-side-panel-width";
import {
  computeWorkspacePanelSizes,
  type WorkspaceVisibility,
} from "@/hooks/use-layout-state";
import { NewChatCrumb } from "@/components/header/shell-breadcrumb";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ThreadsMenu } from "@/components/chat/threads-menu";
import { SidePanel } from "./side-panel";
import { PanelCollapseToggle } from "./toggle-buttons";
import { PanelHeader } from "./panel-header";

const SIDE_PANEL_ID = "workspace-side-panel";
const MAIN_PANEL_ID = "workspace-main-panel";
const PANEL_SEPARATOR_ID = "workspace-panel-separator";

/**
 * One panel column: a rounded card that runs the full height of the column.
 * Its child owns any topbar, so the shell never branches on routed content.
 *
 * translateZ(0) promotes the card to its own layer so the Preview iframe clips
 * to the rounded corners (iframes ignore border-radius clipping otherwise,
 * leaving square corners).
 */
function PanelCard({
  children,
  header,
  inactive = false,
  testId,
}: PropsWithChildren<{
  header?: ReactNode;
  /** Preserve route state while removing a collapsed panel from the a11y tree. */
  inactive?: boolean;
  testId: string;
}>) {
  const card =
    "min-h-0 flex-1 overflow-hidden rounded-[0.75rem] bg-background card-shadow [transform:translateZ(0)]";

  return (
    <div className="flex h-full min-h-0 flex-col p-0.5">
      <div
        data-testid={testId}
        inert={inactive ? true : undefined}
        aria-hidden={inactive ? true : undefined}
        className={cn(card, "flex flex-col")}
      >
        {header}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

export interface WorkspacePanelGroupProps extends WorkspaceVisibility {
  virtualMcpId: string;
  /** The open thread, or `null` on a destination route that names none. */
  taskId: string | null;
  toggleMain: () => void;
  chatContent?: ReactNode;
  mainContent: ReactNode;
}

export function WorkspacePanelGroup({
  virtualMcpId,
  taskId,
  sidePanelOpen,
  mainOpen,
  toggleMain,
  chatContent,
  mainContent,
}: WorkspacePanelGroupProps) {
  const [sidePanelWidth, setSidePanelWidth] = useSidePanelWidth();
  const panelGroupRef = useRef<GroupImperativeHandle>(null);
  const sizes = computeWorkspacePanelSizes({ sidePanelOpen, mainOpen });
  const sideSize = sidePanelOpen && mainOpen ? sidePanelWidth : sizes.side;
  const mainSize = 100 - sideSize;

  // The thread list and new-chat action live in the chat panel header.
  const newChatCrumb = <NewChatCrumb />;
  const threadsMenu = <ThreadsMenu />;

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
            disabled={!sidePanelOpen}
            onToggle={toggleMain}
          />
        )}
      </div>
    </PanelHeader>
  );

  return (
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
        defaultSize={`${sizes.side}%`}
        minSize="20%"
        collapsible
        collapsedSize="0%"
        data-workspace-panel-open={sidePanelOpen ? "" : undefined}
        className="min-w-0 overflow-hidden bg-sidebar"
      >
        <PanelCard
          testId="side-panel"
          header={sidePanelOpen ? chatHeader : null}
        >
          {sidePanelOpen && <SidePanel chatContent={chatContent} />}
        </PanelCard>
      </ResizablePanel>

      {/* Visibility is URL-owned. Leaving the separator enabled with one panel
          collapsed lets pointer/keyboard resizing mutate only the library's
          internal layout, producing a visible panel whose URL state (and inert
          state) still says it is closed. The panel toggles are the sole reopen
          affordance until both sides are present again. */}
      {sidePanelOpen && mainOpen && (
        <ResizableHandle id={PANEL_SEPARATOR_ID} className="bg-sidebar" />
      )}

      <ResizablePanel
        id={MAIN_PANEL_ID}
        defaultSize={`${sizes.main}%`}
        minSize="20%"
        collapsible
        collapsedSize="0%"
        data-workspace-panel-open={mainOpen ? "" : undefined}
        className="min-w-0 overflow-hidden bg-sidebar"
      >
        <PanelCard testId="main-panel" inactive={!mainOpen}>
          {mainContent}
        </PanelCard>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
