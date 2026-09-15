/** Shares thread state across workspace routes and hosts the mobile topbar. */

import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Outlet, useSearch } from "@tanstack/react-router";
import { CommerceConnectModal } from "@/routes/commerce-onboarding/commerce-connect-modal";
import { StudioSidebarMobile } from "@/components/sidebar";
import { ChatPrefsProvider } from "@/components/chat/context";
import { ThreadManagerProvider } from "@/components/chat/store/hooks";
import { Panel } from "@/components/panel";
import {
  MobileSidebarSheet,
  SidebarTriggerButton,
} from "@/layouts/shell-controls";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";

export default function OrgShellLayout() {
  const isMobile = useIsMobile();
  // Commerce onboarding hands off here: after site setup it lands on the org
  // home thread with `?connect=1`, which mounts the blocking connections modal
  // over the (blurred) org home until at least one data source is connected.
  const { connect, siteUrl: connectSiteUrl } = useSearch({ strict: false }) as {
    connect?: string;
    siteUrl?: string;
  };
  /**
   * Scoped by the `?connect=1` param, which ONLY the commerce onboarding
   * hand-off ever sets — a regular org never navigates with it, so it can't be
   * locked. Deliberately not also gated on `reports_only`: that flag trims the
   * footer and the main-panel tabs, never the destinations, so an org carrying
   * it still has a full org home to render behind the modal.
   */
  const showConnectModal = connect === "1";
  const mobileHeader = (
    <Panel.Topbar className="px-1 bg-sidebar">
      <Panel.Topbar.Left className="shrink-0">
        <SidebarTriggerButton />
      </Panel.Topbar.Left>
      <Panel.Topbar.Center className="justify-start">
        <Panel.Topbar.Center.Target />
      </Panel.Topbar.Center>
    </Panel.Topbar>
  );

  return (
    <ThreadManagerProvider>
      <Panel variant="plain" className="bg-sidebar">
        <ChatPrefsProvider>
          {/* The sidebar row belongs to `OrgLayout`; this is what goes INSIDE
              its inset. Mobile keeps a shared top bar because it has no
              side-by-side split; desktop panels own their own headers. */}
          <div className="flex flex-col h-full min-h-0">
            {isMobile && mobileHeader}
            <div className="relative flex-1 min-h-0 flex flex-row">
              <MainPanelBoundary>
                <Outlet />
              </MainPanelBoundary>
            </div>
          </div>
          {isMobile && (
            <MobileSidebarSheet
              renderSidebar={({ onClose }) => (
                <div className="flex h-full">
                  <div
                    className="w-full bg-sidebar flex flex-col overflow-y-auto group/sidebar"
                    data-state="expanded"
                  >
                    <StudioSidebarMobile onClose={onClose} />
                  </div>
                </div>
              )}
            />
          )}
          {showConnectModal && (
            <CommerceConnectModal siteUrl={connectSiteUrl} />
          )}
        </ChatPrefsProvider>
      </Panel>
    </ThreadManagerProvider>
  );
}
