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

import { Suspense } from "react";
import {
  SidebarInset,
  SidebarLayout,
  SidebarProvider,
} from "@decocms/ui/components/sidebar.tsx";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Outlet, useSearch } from "@tanstack/react-router";
import { CommerceConnectModal } from "@/routes/commerce-onboarding/commerce-connect-modal";
import { SidebarResizeHandle } from "@/components/sidebar/sidebar-resize-handle";
import { useSidebarResize } from "@/hooks/use-sidebar-resize";
import { StudioSidebar, StudioSidebarMobile } from "@/components/sidebar";
import { ChatPrefsProvider } from "@/components/chat/context";
import { ThreadManagerProvider } from "@/components/chat/store/hooks";
import { AgentSwitcherCrumb } from "@/components/header/shell-breadcrumb";
import { Toolbar } from "@/layouts/agent-shell-layout/toolbar";
import {
  MobileSidebarSheet,
  SidebarTriggerButton,
} from "@/layouts/shell-controls";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { ShellRouteLoading } from "@/layouts/shell-route-loading";
import { useReportsOnly } from "@/hooks/use-organization-settings";

const SIDEBAR_OPEN_STORAGE_KEY = "sidebar.open";

function RouteFallback() {
  return <ShellRouteLoading />;
}

export default function OrgShellLayout() {
  const isMobile = useIsMobile();
  // Commerce (reports-only) orgs keep the full shell but with a curated top bar:
  // no agent switcher crumb (see CollapsedAgentCrumb + the mobile header). The
  // heavier curation (no Customize / Automations / Settings) lives in the home
  // board and the tab bar, keyed off the same flag.
  const reportsOnly = useReportsOnly();
  // Commerce onboarding hands off here: after site setup it lands on the org
  // home thread with `?connect=1`, which mounts the blocking connections modal
  // over the (blurred) org home until at least one data source is connected.
  const { connect, siteUrl: connectSiteUrl } = useSearch({ strict: false }) as {
    connect?: string;
    siteUrl?: string;
  };
  // Scoped by the `?connect=1` param, which ONLY the commerce onboarding
  // hand-off ever sets — a regular org (e.g. the deco org) never navigates with
  // it, so it can't be locked. We intentionally do NOT also gate on
  // `reports_only`: that flag collapses the org UI, which would leave nothing
  // but a blank surface behind the modal instead of the org home.
  const showConnectModal = connect === "1";
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(
    SIDEBAR_OPEN_STORAGE_KEY,
    false,
  );
  const { width, wrapperRef, onStartResize, resetWidth } = useSidebarResize();

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
        {/* No agent switcher for commerce (reports-only) orgs. */}
        {!reportsOnly && (
          <div className="flex min-w-0 flex-1 items-center">
            <AgentSwitcherCrumb />
          </div>
        )}
        <Toolbar.TogglesSlot />
        <Toolbar.TabsSlot className="shrink-0" />
        <Toolbar.CenterSlot />
        <Toolbar.RightSlot />
      </div>
    </Toolbar.Header>
  );

  const inset = (
    <SidebarInset
      className="flex flex-col min-h-0"
      style={{
        background: "transparent",
        containerType: "inline-size",
      }}
    >
      <div className="flex flex-col h-full min-h-0">
        <div className="relative flex-1 min-h-0 flex flex-row">
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </div>
      </div>
    </SidebarInset>
  );

  return (
    <ThreadManagerProvider>
      <Toolbar.Provider>
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <ChatPrefsProvider>
            <div className="app-shell-root flex flex-col h-dvh overflow-hidden">
              {/* Shared header on top for mobile only; desktop panels each own
                  their own header. */}
              {headerOnTop && mobileHeader}
              <SidebarLayout
                ref={wrapperRef}
                className="flex-1 bg-sidebar relative min-h-0"
                style={
                  {
                    "--sidebar-width": `${width}px`,
                    // 3.125rem → collapsed-rail buttons are 34px (calc(3.125rem -
                    // 1rem)), matching the expanded toolbar's 34px icon buttons so
                    // the sidebar toggle + new-task don't jump size between
                    // open/collapsed.
                    "--sidebar-width-icon": "3.125rem",
                  } as Record<string, string>
                }
              >
                {!isMobile && (
                  <>
                    <StudioSidebar />
                    <SidebarResizeHandle
                      onPointerDown={onStartResize}
                      onDoubleClick={resetWidth}
                    />
                  </>
                )}
                {inset}
              </SidebarLayout>
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
            </div>
          </ChatPrefsProvider>
        </SidebarProvider>
      </Toolbar.Provider>
    </ThreadManagerProvider>
  );
}
