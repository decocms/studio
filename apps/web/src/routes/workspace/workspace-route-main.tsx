import type { ReactNode } from "react";
import { Main } from "@/components/main";
import {
  WorkspaceMainLeading,
  WorkspaceMainTrailing,
} from "@/layouts/agent-shell-layout/workspace-main-controls";
import { ErrorBoundary } from "@/components/error-boundary";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { MainPanelTestErrorTrigger } from "@/layouts/main-panel-test-error-trigger";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useRouteMainTitle } from "@/hooks/use-route-main-title";
import { RouteMainTitle } from "@/layouts/route-main-title";

export interface WorkspaceRouteMainProps {
  actions?: ReactNode;
  center?: ReactNode;
  children: ReactNode;
  /**
   * Routes declare whether Main or their canvas owns scrolling. Keeping this
   * semantic prevents an incidental utility class from creating two scroll
   * containers.
   */
  contentMode?: "scroll" | "canvas";
  /** Explicit route-owned content after the title in the left topbar slot. */
  leading?: ReactNode;
  /**
   * Identity of the rendered route payload for error recovery. Defaults to the
   * canonical panel tab, but sibling URLs that share a tab (for example Tasks
   * list/detail) must distinguish their payloads here.
   */
  boundaryKey?: string;
  /** Home keeps a semantic heading without adding a visible topbar title. */
  hideTitle?: boolean;
  /** Overrides fixed route metadata for entity- and payload-derived titles. */
  title?: string;
}

export function WorkspaceRouteMain({
  actions,
  center,
  children,
  contentMode = "scroll",
  leading,
  hideTitle = false,
  boundaryKey,
  title,
}: WorkspaceRouteMainProps) {
  const routeKey = useActivePanelTabId() ?? "route-main";
  const routeBoundaryKey = boundaryKey ?? routeKey;
  const fixedRouteTitle = useRouteMainTitle();
  const routeTitle = title?.trim() || fixedRouteTitle;

  return (
    <Main>
      <Main.Topbar>
        <Main.Topbar.Left>
          <WorkspaceMainLeading currentRouteTitle={routeTitle}>
            {routeTitle ? (
              <RouteMainTitle title={routeTitle} hidden={hideTitle} compact />
            ) : null}
            {leading}
          </WorkspaceMainLeading>
          <Main.Topbar.Left.Target />
        </Main.Topbar.Left>
        <Main.Topbar.Center>
          {center}
          <Main.Topbar.Center.Target />
        </Main.Topbar.Center>
        <Main.Topbar.Right>
          <Main.Topbar.Right.Target />
          {actions}
          <WorkspaceMainTrailing />
        </Main.Topbar.Right>
      </Main.Topbar>
      <Main.Toolbar />
      <Main.Content mode={contentMode}>
        <ErrorBoundary resetKey={routeBoundaryKey}>
          <MainPanelBoundary>
            <MainPanelTestErrorTrigger routeId={routeBoundaryKey}>
              {children}
            </MainPanelTestErrorTrigger>
          </MainPanelBoundary>
        </ErrorBoundary>
      </Main.Content>
    </Main>
  );
}
