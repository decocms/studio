/** Persistent desktop workspace: SidePanel | MainPanel. */

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
import { useSidePanelWidth } from "@/web/hooks/use-side-panel-width";
import {
  computeWorkspacePanelSizes,
  type WorkspaceVisibility,
} from "@/web/hooks/use-layout-state";
import { MainPanelWithDrawer } from "@/web/layouts/main-panel-tabs/main-panel-with-drawer";
import { SidePanel } from "./side-panel";

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
        <div className="desktop-wco-safe-content h-full min-h-0">
          {children}
        </div>
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
  const [sidePanelWidth, setSidePanelWidth] = useSidePanelWidth();
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const visibility = { sidePanel, mainOpen };
  const sizes = computeWorkspacePanelSizes(visibility);
  const sideSize = sidePanel !== null && mainOpen ? sidePanelWidth : sizes.side;
  const mainSize = 100 - sideSize;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- syncs URL-derived visibility with the resizable panels' imperative layout API
  useEffect(() => {
    panelGroupRef.current?.setLayout([sideSize, mainSize]);
  }, [sideSize, mainSize]);

  return (
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
        <PanelCard testId="side-panel">
          {sidePanel !== null && <SidePanel chatContent={chatContent} />}
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
        <PanelCard testId="main-panel">
          <MainPanelWithDrawer taskId={taskId} virtualMcpId={virtualMcpId} />
        </PanelCard>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
