/**
 * Org Shell Layout
 *
 * Shared parent for org workspace routes. Owns thread/chat providers and the
 * mobile sidebar sheet; each matched route owns its Main topbar and content.
 *
 * Shell shape (default):
 *   SidebarProvider
 *   └── app-shell-root (flex-col, h-dvh)
 *       └── SidebarLayout            — body row
 *           ├── StudioSidebar (desktop only)
 *           ├── SidebarResizeHandle (desktop only)
 *           └── SidebarInset         — routed content
 *
 * On desktop the sidebar owns the full height and the toolbar header lives in
 * the right column so it only spans above the panels — the org selector +
 * collapse toggle live in the sidebar's own header instead of the top bar.
 *
 *   + Sheet for mobile sidebar (rendered alongside, portal-based)
 */

import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Outlet, useSearch } from "@tanstack/react-router";
import { CommerceConnectModal } from "@/routes/commerce-onboarding/commerce-connect-modal";
import { StudioSidebarMobile } from "@/components/sidebar";
import { ChatPrefsProvider } from "@/components/chat/context";
import { ThreadManagerProvider } from "@/components/chat/store/hooks";
import { MobileSidebarSheet } from "@/layouts/shell-controls";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";

export default function OrgShellLayout() {
  const isMobile = useIsMobile();
  // Commerce onboarding hands off here: after site setup it lands on the org
  // Home surface with `?connect=1`, which mounts the blocking connections modal
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
  return (
    <ThreadManagerProvider>
      <ChatPrefsProvider>
        <div className="flex flex-col h-full min-h-0">
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
        {showConnectModal && <CommerceConnectModal siteUrl={connectSiteUrl} />}
      </ChatPrefsProvider>
    </ThreadManagerProvider>
  );
}
