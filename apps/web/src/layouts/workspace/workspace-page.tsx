import type { ReactNode } from "react";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Panel } from "@/components/panel";
import { ErrorBoundary } from "@/components/error-boundary";
import { DevAgentControl } from "@/components/dev-agent/dev-agent-control";
import { MainPanelBoundary, PanelLoading } from "@/layouts/main-panel-boundary";
import { MainPanelTabsBar } from "@/layouts/main-panel-tabs/main-panel-tabs-bar";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { PanelCollapseToggle } from "@/layouts/agent-shell-layout/toggle-buttons";
import { useWorkspace } from "./workspace-context";

function PageBody({
  children,
  routeId,
}: {
  children: ReactNode;
  routeId: string;
}) {
  if (
    (import.meta.env.DEV || __E2E_TEST_HOOKS__) &&
    typeof window !== "undefined" &&
    "__forceTabError" in window &&
    window.__forceTabError === routeId
  ) {
    throw new Error(`forced tab error: ${routeId}`);
  }
  return children;
}

/** Keeps the route frame available while TanStack loads a destination's chunk. */
export function WorkspacePagePending() {
  return (
    <WorkspacePage>
      <PanelLoading />
    </WorkspacePage>
  );
}

/** Standard route composition. Feature state stays in children and their portals. */
export function WorkspacePage({
  children,
  actions,
  drawer,
}: {
  children: ReactNode;
  actions?: ReactNode;
  drawer?: ReactNode;
}) {
  const workspace = useWorkspace();
  const isMobile = useIsMobile();
  const routeId = useActivePanelTabId() ?? "overview";

  return (
    <Panel data-testid="main-panel" variant={isMobile ? "plain" : "card"}>
      {!isMobile && workspace.mainOpen && (
        <Panel.Topbar>
          <Panel.Topbar.Left className="gap-0.5">
            <PanelCollapseToggle
              side="left"
              open={workspace.sidePanelOpen}
              onToggle={workspace.toggleSidePanel}
            />
            <MainPanelTabsBar
              virtualMcpId={workspace.virtualMcpId}
              taskId={workspace.threadId}
            />
            <Panel.Topbar.Left.Target />
          </Panel.Topbar.Left>
          <Panel.Topbar.Center>
            <div className="flex min-w-0 items-center @max-sm/panel-header:hidden">
              <Panel.Topbar.Center.Target />
            </div>
          </Panel.Topbar.Center>
          <Panel.Topbar.Right>
            <Panel.Topbar.Right.Target />
            {workspace.entity && (
              <DevAgentControl virtualMcp={workspace.entity} />
            )}
            {actions}
            <PanelCollapseToggle
              side="right"
              open={workspace.mainOpen}
              onToggle={workspace.toggleMain}
            />
          </Panel.Topbar.Right>
        </Panel.Topbar>
      )}
      <Panel.Content>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary key={routeId}>
            <MainPanelBoundary>
              <PageBody routeId={routeId}>{children}</PageBody>
            </MainPanelBoundary>
          </ErrorBoundary>
        </div>
        {drawer}
      </Panel.Content>
    </Panel>
  );
}
