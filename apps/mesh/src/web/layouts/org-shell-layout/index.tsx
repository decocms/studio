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
 * When SIDEBAR_NAV_BUTTONS is on (desktop), the sidebar owns the full height
 * and the toolbar header moves INTO the right column so it only spans above
 * the panels — the org selector + collapse toggle live in the sidebar's own
 * header instead of the top bar.
 *
 *   + Sheet for mobile sidebar (rendered alongside, portal-based)
 */

import { Suspense } from "react";
import {
  SidebarInset,
  SidebarLayout,
  SidebarProvider,
} from "@deco/ui/components/sidebar.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { Outlet } from "@tanstack/react-router";
import { SidebarResizeHandle } from "@/web/components/sidebar/sidebar-resize-handle";
import { useSidebarResize } from "@/web/hooks/use-sidebar-resize";
import { StudioSidebar, StudioSidebarMobile } from "@/web/components/sidebar";
import { ChatPrefsProvider } from "@/web/components/chat/context";
import { ThreadManagerProvider } from "@/web/components/chat/store/hooks";
import { LinkedDesktopIndicator } from "@/web/components/header/linked-desktop-indicator";
import { ShellBreadcrumb } from "@/web/components/header/shell-breadcrumb";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import {
  MobileSidebarSheet,
  SidebarTriggerButton,
} from "@/web/layouts/shell-controls";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { ShellRouteLoading } from "@/web/layouts/shell-route-loading";
import { SIDEBAR_NAV_BUTTONS } from "@/web/flags";

const SIDEBAR_OPEN_STORAGE_KEY = "sidebar.open";

function RouteFallback() {
  return <ShellRouteLoading />;
}

export default function OrgShellLayout() {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(
    SIDEBAR_OPEN_STORAGE_KEY,
    false,
  );
  const { width, wrapperRef, onStartResize, resetWidth } = useSidebarResize();

  // With the sidebar nav experiment on (desktop only), the header lives in the
  // right column above the panels rather than full-width above the sidebar.
  const headerInRightColumn = SIDEBAR_NAV_BUTTONS && !isMobile;

  const desktopHeader = (
    <Toolbar.Header>
      <Toolbar.LeftColumn>
        {!SIDEBAR_NAV_BUTTONS && <ShellBreadcrumb />}
        {!SIDEBAR_NAV_BUTTONS && <SidebarTriggerButton />}
        <Toolbar.TogglesSlot />
      </Toolbar.LeftColumn>
      <Toolbar.CenterSlot />
      <Toolbar.RightColumn>
        <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] flex justify-end items-center gap-0.5">
          <Toolbar.TabsSlot />
        </div>
        <Toolbar.RightSlot />
      </Toolbar.RightColumn>
    </Toolbar.Header>
  );

  const mobileHeader = (
    <Toolbar.Header className="grid-cols-1 px-1 pr-1">
      <div className="flex w-full items-center gap-2">
        <SidebarTriggerButton />
        <ShellBreadcrumb />
        <LinkedDesktopIndicator />
        <div aria-hidden className="flex-1 min-w-0" />
        <Toolbar.TogglesSlot />
        <Toolbar.TabsSlot className="min-w-0" />
      </div>
      <Toolbar.CenterSlot />
      <Toolbar.RightSlot />
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
              {/* Header on top: mobile always, desktop unless the sidebar owns
                  the full height. */}
              {!headerInRightColumn &&
                (isMobile ? mobileHeader : desktopHeader)}
              <SidebarLayout
                ref={wrapperRef}
                className="flex-1 bg-sidebar relative min-h-0"
                style={
                  {
                    "--sidebar-width": `${width}px`,
                    "--sidebar-width-icon": "3.5rem",
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
                {headerInRightColumn ? (
                  <div className="flex flex-col flex-1 min-w-0 min-h-0 h-full">
                    {desktopHeader}
                    {inset}
                  </div>
                ) : (
                  inset
                )}
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
            </div>
          </ChatPrefsProvider>
        </SidebarProvider>
      </Toolbar.Provider>
    </ThreadManagerProvider>
  );
}
