/** Route-owned composition for `/$org/settings/*`. */

import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Main } from "@/components/main";
import { ErrorBoundary } from "@/components/error-boundary";
import { PageContentClassNameProvider } from "@/components/page";
import { useT } from "@/i18n/use-t";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import {
  MobileSidebarSheet,
  SidebarTriggerButton,
} from "@/layouts/shell-controls";
import { SettingsSidebarMobile } from "@/components/sidebar/settings-sidebar";
import { useProjectContext } from "@/sdk";
import { useStatusSounds } from "../hooks/use-status-sounds";

export default function SettingsLayout() {
  const t = useT();
  const isMobile = useIsMobile();
  const { org } = useProjectContext();
  const routeKey = useRouterState({
    select: (state) => state.location.pathname,
  });

  useStatusSounds(org.slug);

  return (
    <>
      <Main className="bg-sidebar p-0 md:p-1.5">
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background md:rounded-[0.75rem] md:card-shadow">
          <Main.Topbar>
            <Main.Topbar.Left>
              <div className="md:hidden">
                <SidebarTriggerButton />
              </div>
              <Main.Title>{t("sidebar.navDestinations.settings")}</Main.Title>
              <Main.Topbar.Left.Target />
            </Main.Topbar.Left>
            <Main.Topbar.Center>
              <Main.Topbar.Center.Target />
            </Main.Topbar.Center>
            <Main.Topbar.Right>
              <Main.Topbar.Right.Target />
            </Main.Topbar.Right>
          </Main.Topbar>

          <Main.Content className="overflow-hidden">
            <ErrorBoundary key={routeKey}>
              <MainPanelBoundary>
                <PageContentClassNameProvider value="p-0">
                  <Outlet />
                </PageContentClassNameProvider>
              </MainPanelBoundary>
            </ErrorBoundary>
          </Main.Content>
        </div>
      </Main>

      {isMobile && (
        <MobileSidebarSheet
          renderSidebar={({ onClose }) => (
            <SettingsSidebarMobile onClose={onClose} />
          )}
        />
      )}
    </>
  );
}
