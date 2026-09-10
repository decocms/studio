/**
 * Org Shell Layout
 *
 * Shared parent for `/$org/` (home) and `/$org/$taskId` (chat). Owns the
 * toolbar header, the sidebar row, and ChatPrefsProvider.
 *
 * Shell shape (default):
 *   SidebarProvider
 *   └── app-shell-root (flex-col, h-dvh)
 *       ├── Toolbar.Header           — full-width, fixed left zone
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
import { Toolbar } from "@/layouts/agent-shell-layout/toolbar";
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
  // On desktop each panel owns its own 48px header (see WorkspacePanelGroup), so
  // there is no shared top bar spanning the panels — only the mobile layout,
  // which has no side-by-side split, keeps a single shared header on top.
  const headerOnTop = isMobile;

  // Single flex row. Like the desktop collapsed topbar, only the *agent* shows
  // here (it flexes and truncates) — the org switcher lives in the sidebar
  // sheet, reached via the hamburger. The linked-desktop indicator, toggles and
  // view select stay shrink-0. The Center / Right portal targets ride along at
  // the end (usually empty on mobile) so nothing spills onto a second row.
  const mobileHeader = (
    <Toolbar.Header className="grid-cols-1 px-1">
      <div className="flex w-full min-w-0 items-center gap-1">
        <SidebarTriggerButton />
        <Toolbar.TogglesSlot />
        <Toolbar.TabsSlot className="shrink-0" />
        <Toolbar.CenterSlot />
        <Toolbar.RightSlot />
      </div>
    </Toolbar.Header>
  );

  return (
    <ThreadManagerProvider>
      <Toolbar.Provider>
        <ChatPrefsProvider>
          {/* The sidebar row belongs to `OrgLayout`; this is what goes INSIDE
              its inset. Mobile keeps a shared top bar because it has no
              side-by-side split; desktop panels own their own headers. */}
          <div className="flex flex-col h-full min-h-0">
            {headerOnTop && mobileHeader}
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
      </Toolbar.Provider>
    </ThreadManagerProvider>
  );
}
