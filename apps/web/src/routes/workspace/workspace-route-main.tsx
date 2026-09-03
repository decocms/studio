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

export interface WorkspaceRouteMainProps {
  actions?: ReactNode;
  center?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  /** Explicit route-owned content after the title in the left topbar slot. */
  leading?: ReactNode;
  /** Overrides fixed route metadata for entity- and payload-derived titles. */
  title?: string;
}

export function WorkspaceRouteMain({
  actions,
  center,
  children,
  contentClassName,
  leading,
  title,
}: WorkspaceRouteMainProps) {
  const routeKey = useActivePanelTabId() ?? "route-main";
  const fixedRouteTitle = useRouteMainTitle();
  const routeTitle = title?.trim() || fixedRouteTitle;

  return (
    <Main>
      <Main.Topbar>
        <Main.Topbar.Left>
          <WorkspaceMainLeading currentRouteTitle={routeTitle}>
            {routeTitle ? (
              <Main.Title className="max-md:sr-only">{routeTitle}</Main.Title>
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
          <WorkspaceMainTrailing>{actions}</WorkspaceMainTrailing>
        </Main.Topbar.Right>
      </Main.Topbar>
      <Main.Subheader className="md:hidden" />
      <Main.Content className={contentClassName}>
        <ErrorBoundary key={routeKey}>
          <MainPanelBoundary>
            <MainPanelTestErrorTrigger routeId={routeKey}>
              {children}
            </MainPanelTestErrorTrigger>
          </MainPanelBoundary>
        </ErrorBoundary>
      </Main.Content>
    </Main>
  );
}
