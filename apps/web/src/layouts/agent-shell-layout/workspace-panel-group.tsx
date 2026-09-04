/**
 * Persistent desktop workspace: MainPanel | ChatPanel.
 *
 * Each panel is one full-height card. Chat owns a `PanelHeader`; every routed
 * Main surface owns its own `Main.Topbar`. Chat's visibility control stays at
 * Main's trailing edge; when Main is hidden, its recovery control appears at
 * Chat's leading edge.
 */

import { useRef, type PropsWithChildren, type ReactNode } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type GroupImperativeHandle,
} from "@/components/resizable";
import { useSidePanelWidth } from "@/hooks/use-side-panel-width";
import { useElementSize } from "@/hooks/use-element-size";
import {
  computeWorkspacePanelSizes,
  type MobileWorkspaceSurface,
  type WorkspaceVisibility,
} from "@/hooks/use-layout-state";
import { NewChatCrumb } from "@/components/header/shell-breadcrumb";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ThreadsMenu } from "@/components/chat/threads-menu";
import { SidePanel } from "./side-panel";
import { PanelVisibilityToggle } from "./toggle-buttons";
import { PanelHeader } from "./panel-header";
import { useT } from "@/i18n/use-t";
import { MobileMainPanelTabSelect } from "@/layouts/main-panel-tabs/mobile-main-panel-tab-select";
import { SidebarTriggerButton } from "@/layouts/shell-controls";

const SIDE_PANEL_ID = "workspace-side-panel";
const MAIN_PANEL_ID = "workspace-main-panel";
const PANEL_SEPARATOR_ID = "workspace-panel-separator";
/** Below this actual shell width, two editor columns stop being viable. */
const STACKED_WORKSPACE_MAX_WIDTH = 900;
const STACKED_CHAT_SIZE = 35;
const MAIN_COLUMN_MIN_SIZE = "560px";
const CHAT_COLUMN_MIN_SIZE = "320px";
const STACKED_PANEL_PREFERRED_MIN_SIZE = 220;
/** Group padding plus its one-pixel horizontal separator. */
const STACKED_NON_PANEL_HEIGHT = 9;

function stackedPanelMinSize(workspaceHeight: number): string {
  const availableHeight = Math.max(
    0,
    workspaceHeight - STACKED_NON_PANEL_HEIGHT,
  );
  return `${Math.min(
    STACKED_PANEL_PREFERRED_MIN_SIZE,
    Math.floor(availableHeight / 2),
  )}px`;
}

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
    <div className="flex h-full min-h-0 flex-col p-0.5 max-md:p-0">
      <div
        data-testid={testId}
        inert={inactive ? true : undefined}
        aria-hidden={inactive ? true : undefined}
        className={cn(
          card,
          "flex flex-col max-md:rounded-none max-md:shadow-none",
        )}
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
  openMain: () => void;
  chatContent?: ReactNode;
  mainContent: ReactNode;
  /** Mobile presents one surface while keeping both panel subtrees mounted. */
  mobileSurface?: MobileWorkspaceSurface;
}

export function WorkspacePanelGroup({
  virtualMcpId,
  taskId,
  sidePanelOpen,
  mainOpen,
  openMain,
  chatContent,
  mainContent,
  mobileSurface,
}: WorkspacePanelGroupProps) {
  const t = useT();
  const mobile = mobileSurface !== undefined;
  const mainVisible = mobile ? mobileSurface === "main" : mainOpen;
  const sidePanelVisible = mobile ? mobileSurface === "chat" : sidePanelOpen;
  const [{ width: workspaceWidth, height: workspaceHeight }, workspaceRef] =
    useElementSize();
  const stacked =
    workspaceWidth >= 0 && workspaceWidth < STACKED_WORKSPACE_MAX_WIDTH;
  const [sidePanelWidth, setSidePanelWidth] = useSidePanelWidth();
  const sizes = computeWorkspacePanelSizes({
    sidePanelOpen: sidePanelVisible,
    mainOpen: mainVisible,
  });
  const sideSize =
    sidePanelVisible && mainVisible
      ? stacked
        ? STACKED_CHAT_SIZE
        : sidePanelWidth
      : sizes.side;
  const mainSize = 100 - sideSize;
  const desiredLayout = {
    [MAIN_PANEL_ID]: mainSize,
    [SIDE_PANEL_ID]: sideSize,
  };
  const stackedMinSize = stackedPanelMinSize(workspaceHeight);
  const layoutSignature = `${stacked}:${mainSize}:${sideSize}:${stackedMinSize}`;
  const lastLayoutCommitRef = useRef<{
    handle: GroupImperativeHandle;
    signature: string;
  } | null>(null);

  // A fresh callback ref is committed whenever URL visibility, persisted size,
  // or orientation changes. The library exposes its handle before registering
  // the Group, so the microtask crosses the rest of that commit before using
  // it. React 19 runs the returned cleanup when a newer commit supersedes this
  // one, preventing a stale layout from landing after a rapid transition.
  const syncPanelGroupLayout = (handle: GroupImperativeHandle | null) => {
    if (!handle) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const lastCommit = lastLayoutCommitRef.current;
      if (
        lastCommit?.handle === handle &&
        lastCommit.signature === layoutSignature
      ) {
        return;
      }
      const current = handle.getLayout();
      if (
        Math.abs((current[MAIN_PANEL_ID] ?? -1) - mainSize) >= 0.01 ||
        Math.abs((current[SIDE_PANEL_ID] ?? -1) - sideSize) >= 0.01
      ) {
        handle.setLayout(desiredLayout);
      }
      lastLayoutCommitRef.current = { handle, signature: layoutSignature };
    });
    return () => {
      active = false;
    };
  };

  // The thread list and new-chat action live in the chat panel header.
  const newChatCrumb = <NewChatCrumb />;
  const threadsMenu = <ThreadsMenu />;

  const chatHeader = (
    <>
      <PanelHeader className="max-md:hidden">
        {/* Main is physically left of Chat. Its recovery control appears at
            Chat's leading edge only while Main is hidden. */}
        {!mainOpen && (
          <PanelVisibilityToggle
            panel="main"
            open={false}
            onToggle={openMain}
          />
        )}
        {threadsMenu}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {newChatCrumb}
        </div>
      </PanelHeader>
      <PanelHeader className="border-b border-border/60 bg-background px-1.5 md:hidden">
        <SidebarTriggerButton />
        <MobileMainPanelTabSelect />
      </PanelHeader>
    </>
  );

  return (
    <div ref={workspaceRef} className="flex min-h-0 min-w-0 flex-1">
      <ResizablePanelGroup
        ref={syncPanelGroupLayout}
        key={`${virtualMcpId}-${taskId}`}
        defaultLayout={desiredLayout}
        orientation={stacked ? "vertical" : "horizontal"}
        data-workspace-layout={stacked ? "stacked" : "columns"}
        className={cn(
          // Full-height cards need the same room above as below.
          "min-h-0 min-w-0 flex-1 pt-1 pb-1 pr-1 pl-0 max-md:p-0",
          stacked
            ? "flex-col [&>[data-workspace-panel-open]]:!min-h-0 [&>[data-workspace-panel-open]]:!min-w-0"
            : "flex-row",
        )}
        style={{ overflow: "visible" }}
        onLayoutChanged={(layout, { isUserInteraction }) => {
          const percentage = layout[SIDE_PANEL_ID];
          if (
            isUserInteraction &&
            !mobile &&
            !stacked &&
            sidePanelVisible &&
            mainVisible &&
            typeof percentage === "number" &&
            percentage > 0 &&
            percentage < 100
          ) {
            setSidePanelWidth(percentage);
          }
        }}
      >
        <ResizablePanel
          id={MAIN_PANEL_ID}
          defaultSize={`${mainSize}%`}
          minSize={stacked ? stackedMinSize : MAIN_COLUMN_MIN_SIZE}
          collapsible={!mainVisible}
          collapsedSize="0%"
          data-workspace-panel-open={mainVisible ? "" : undefined}
          className="min-w-0 overflow-hidden bg-sidebar"
        >
          <PanelCard testId="main-panel" inactive={!mainVisible}>
            {mainContent}
          </PanelCard>
        </ResizablePanel>

        {/* Visibility is URL-owned. Interactive collapse is disabled above for
            a URL-open panel; a URL-closed panel alone remains collapsible so the
            imperative layout can size it to zero. The separator only exists while
            both panels are present, preventing library state from contradicting
            the URL and its toggle labels. */}
        {sidePanelVisible && mainVisible && (
          <ResizableHandle
            id={PANEL_SEPARATOR_ID}
            aria-label={t("agentShellLayout.workspace.resizePanels")}
            className="bg-sidebar"
          />
        )}

        <ResizablePanel
          id={SIDE_PANEL_ID}
          defaultSize={`${sideSize}%`}
          minSize={stacked ? stackedMinSize : CHAT_COLUMN_MIN_SIZE}
          collapsible={!sidePanelVisible}
          collapsedSize="0%"
          data-workspace-panel-open={sidePanelVisible ? "" : undefined}
          className="min-w-0 overflow-hidden bg-sidebar"
        >
          <PanelCard
            testId="side-panel"
            inactive={!sidePanelVisible}
            header={sidePanelVisible ? chatHeader : null}
          >
            <SidePanel chatContent={chatContent} />
          </PanelCard>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
