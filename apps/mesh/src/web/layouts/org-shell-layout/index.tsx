/**
 * Org Shell Layout
 *
 * Shared parent for `/$org/` (home) and `/$org/$taskId` (chat). Owns the
 * full-width toolbar header, the sidebar row beneath it, and
 * ChatPrefsProvider.
 *
 * Shell shape:
 *   SidebarProvider
 *   └── app-shell-root (flex-col, h-dvh)
 *       ├── Toolbar.Header           — full-width, fixed left zone
 *       └── SidebarLayout            — body row
 *           ├── StudioSidebar (desktop only)
 *           ├── SidebarResizeHandle (desktop only)
 *           └── SidebarInset         — routed content
 *   + Sheet for mobile sidebar (rendered alongside, portal-based)
 */

import { Suspense } from "react";
import {
  SidebarInset,
  SidebarLayout,
  SidebarProvider,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { Sheet, SheetContent, SheetTitle } from "@deco/ui/components/sheet.tsx";
import { LayoutLeft, Loading01 } from "@untitledui/icons";
import { Outlet } from "@tanstack/react-router";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { SidebarResizeHandle } from "@/web/components/sidebar/sidebar-resize-handle";
import { useSidebarResize } from "@/web/hooks/use-sidebar-resize";
import { StudioSidebar, StudioSidebarMobile } from "@/web/components/sidebar";
import { ChatPrefsProvider } from "@/web/components/chat/context";
import { ThreadManagerProvider } from "@/web/components/chat/store/hooks";
import { LinkedDesktopIndicator } from "@/web/components/header/linked-desktop-indicator";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { useLocalStorage } from "@/web/hooks/use-local-storage";

const SIDEBAR_OPEN_STORAGE_KEY = "sidebar.open";

function SidebarTriggerButton() {
  const { toggleSidebar } = useSidebar();
  return (
    <ToolbarIconButton onClick={toggleSidebar} aria-label="Toggle sidebar">
      <LayoutLeft size={16} />
    </ToolbarIconButton>
  );
}

function RouteFallback() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loading01 size={20} className="animate-spin text-muted-foreground" />
    </div>
  );
}

function MobileSidebarSheet() {
  const { openMobile, setOpenMobile } = useSidebar();
  return (
    <Sheet open={openMobile} onOpenChange={setOpenMobile}>
      <SheetContent
        side="left"
        hideCloseButton
        className="w-[calc(100vw-3rem)] sm:max-w-md! p-0"
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="flex h-full">
          <div
            className="w-full bg-sidebar flex flex-col overflow-y-auto group/sidebar"
            data-state="expanded"
          >
            <StudioSidebarMobile onClose={() => setOpenMobile(false)} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function OrgShellLayout() {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(
    SIDEBAR_OPEN_STORAGE_KEY,
    false,
  );
  const { width, wrapperRef, onStartResize, resetWidth } = useSidebarResize();

  return (
    <ThreadManagerProvider>
      <Toolbar.Provider>
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <ChatPrefsProvider>
            <div className="app-shell-root flex flex-col h-dvh overflow-hidden">
              <Toolbar.Header>
                <Toolbar.LeftColumn>
                  <Toolbar.Logo />
                  <SidebarTriggerButton />
                  <span className="hidden md:contents">
                    <Toolbar.Nav />
                  </span>
                  <Toolbar.TogglesSlot />
                  <LinkedDesktopIndicator />
                </Toolbar.LeftColumn>
                <Toolbar.CenterSlot />
                <Toolbar.RightColumn>
                  <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] flex justify-end">
                    <Toolbar.TabsSlot />
                  </div>
                  <Toolbar.RightSlot />
                </Toolbar.RightColumn>
              </Toolbar.Header>
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
                <SidebarInset
                  className="flex flex-col"
                  style={{
                    background: "transparent",
                    containerType: "inline-size",
                  }}
                >
                  <div className="flex flex-col h-full min-h-0">
                    <div className="flex-1 min-h-0 flex flex-row">
                      <Suspense fallback={<RouteFallback />}>
                        <Outlet />
                      </Suspense>
                    </div>
                  </div>
                </SidebarInset>
              </SidebarLayout>
              {isMobile && <MobileSidebarSheet />}
            </div>
          </ChatPrefsProvider>
        </SidebarProvider>
      </Toolbar.Provider>
    </ThreadManagerProvider>
  );
}
