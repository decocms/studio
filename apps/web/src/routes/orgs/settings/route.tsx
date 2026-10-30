import { Outlet, useRouterState } from "@tanstack/react-router";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { RoutePageHeader } from "@/layouts/route-page-header";
import { Panel } from "@/components/panel";
import { Page } from "@/components/page";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { AiUsageButton } from "@/views/settings/ai-providers/plan-usage-card";

export default function SettingsRoute() {
  const isMobile = useIsMobile();
  const onBilling = useRouterState({
    select: (state) =>
      state.location.pathname.endsWith("/settings/ai-providers"),
  });

  return (
    <div className={cn("flex-1 min-h-0", !isMobile && "p-1.5")}>
      <Panel data-testid="settings-panel" variant={isMobile ? "plain" : "card"}>
        <Page.Breadcrumbs.Provider>
          <RoutePageHeader
            actions={onBilling ? <AiUsageButton /> : undefined}
          />
          <Panel.Content>
            <MainPanelBoundary>
              <Outlet />
            </MainPanelBoundary>
          </Panel.Content>
        </Page.Breadcrumbs.Provider>
      </Panel>
    </div>
  );
}
