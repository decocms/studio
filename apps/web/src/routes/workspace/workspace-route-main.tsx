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
  /**
   * Routes declare whether Main or their canvas owns scrolling. Keeping this
   * semantic prevents an incidental utility class from creating two scroll
   * containers.
   */
  contentMode?: "scroll" | "canvas";
  /** Explicit route-owned content after the title in the left topbar slot. */
  leading?: ReactNode;
  /** Explicit semantic parents between the organization and current route. */
  breadcrumbAncestors?: readonly MainBreadcrumbNavigableItem[];
  /** The current destination is the scope itself, as on organization Home. */
  breadcrumbScopeIsCurrent?: boolean;
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
  contentMode = "scroll",
  leading,
  breadcrumbAncestors,
  breadcrumbScopeIsCurrent = false,
  boundaryKey,
  title,
}: WorkspaceRouteMainProps) {
  const t = useT();
  const { org } = useProjectContext();
  const routeKey = useActivePanelTabId() ?? "route-main";
  const routeBoundaryKey = boundaryKey ?? routeKey;
  const fixedRouteTitle = useRouteMainTitle();
  const routeTitle = title?.trim() || fixedRouteTitle;
  const breadcrumbScope = organizationMainBreadcrumbItem(
    org,
    t("sidebar.navDestinations.home"),
  );

  return (
    <Main>
      <Main.Topbar>
        <Main.Topbar.Left>
          <WorkspaceMainLeading currentRouteTitle={routeTitle}>
            {routeTitle ? (
              <MainBreadcrumb
                compactTitle="visually-hidden"
                scope={breadcrumbScope}
                ancestors={breadcrumbAncestors}
                current={{
                  id: breadcrumbScopeIsCurrent
                    ? breadcrumbScope.id
                    : `route:${routeKey}`,
                  label: routeTitle,
                }}
              />
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
      <Main.Toolbar />
      <Main.Content mode={contentMode}>
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
