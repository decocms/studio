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
import {
  MainBreadcrumb,
  type MainBreadcrumbNavigableItem,
} from "@/components/main-breadcrumb";
import { organizationMainBreadcrumbItem } from "@/components/main-breadcrumb/route-items";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t";

export interface WorkspaceRouteMainProps {
  actions?: ReactNode;
  center?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  /** Explicit route-owned content after the title in the left topbar slot. */
  leading?: ReactNode;
  /** Explicit semantic parents between the organization and current route. */
  breadcrumbAncestors?: readonly MainBreadcrumbNavigableItem[];
  /**
   * Identity of the rendered route payload for error recovery. Defaults to the
   * canonical panel tab, but sibling URLs that share a tab (for example Tasks
   * list/detail) must distinguish their payloads here.
   */
  boundaryKey?: string;
  /** Overrides fixed route metadata for entity- and payload-derived titles. */
  title?: string;
}

export function WorkspaceRouteMain({
  actions,
  center,
  children,
  contentClassName,
  leading,
  breadcrumbAncestors,
  boundaryKey,
  title,
}: WorkspaceRouteMainProps) {
  const t = useT();
  const { org } = useProjectContext();
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
              <>
                <MainBreadcrumb
                  className="hidden md:flex"
                  scope={organizationMainBreadcrumbItem(
                    org,
                    t("sidebar.navDestinations.home"),
                  )}
                  ancestors={breadcrumbAncestors}
                  current={{ id: `route:${routeKey}`, label: routeTitle }}
                />
                {/* Mobile's view selector owns the visible route label. Keep a
                    single semantic page heading without leaving invisible
                    breadcrumb actions in the keyboard order. */}
                <Main.Title className="sr-only md:hidden">
                  {routeTitle}
                </Main.Title>
              </>
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
        <ErrorBoundary key={routeBoundaryKey}>
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
