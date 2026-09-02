/** Org Layout — the ONE shell every `/$org/...` route renders into. It owns the
 *  sidebar row: the persisted open state and width, the desktop
 *  `StudioSidebar`, its resize handle, and the `SidebarInset` routed children
 *  land in. It lives HERE rather than in `orgShellLayout` because that layout
 *  and `settingsLayout` are SIBLINGS: a shell owned by one is destroyed the
 *  moment you cross into the other, taking the sidebar with it — which is what
 *  made clicking Settings blank the UI. This route's match is in BOTH chains
 *  and its id never changes, so React keeps this instance across the crossing
 *  and only the inset's contents and the sidebar's slots swap. Everything
 *  chat-shaped stays in `orgShellLayout`, so a cold link straight to
 *  `/$org/settings/...` does not download it; the mobile sheet stays with each
 *  child for the same reason, and because it reads a store whose provider lives
 *  below. */

import { Outlet } from "@tanstack/react-router";
import {
  SidebarInset,
  SidebarLayout,
  SidebarProvider,
} from "@decocms/ui/components/sidebar.tsx";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { StudioSidebar } from "@/components/sidebar";
import { SidebarResizeHandle } from "@/components/sidebar/sidebar-resize-handle";
import { useSidebarResize } from "@/hooks/use-sidebar-resize";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

/** 3.125rem → collapsed-rail buttons are 34px (`calc(3.125rem - 1rem)`),
 *  matching the expanded toolbar's, so the toggle does not change size when the
 *  sidebar collapses. */
const SIDEBAR_ICON_WIDTH = "3.125rem";

export default function OrgLayout() {
  const isMobile = useIsMobile();
  /** Open by default — the collapsed rail is icon-only, so defaulting to it
   *  made a new org's first impression four unlabelled glyphs. */
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(
    LOCALSTORAGE_KEYS.sidebarOpen(),
    true,
  );
  const { width, wrapperRef, onStartResize, resetWidth } = useSidebarResize();

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <div className="app-shell-root flex flex-col h-dvh overflow-hidden">
        <SidebarLayout
          ref={wrapperRef}
          className="flex-1 bg-sidebar relative min-h-0"
          style={
            {
              "--sidebar-width": `${width}px`,
              "--sidebar-width-icon": SIDEBAR_ICON_WIDTH,
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
            className="flex flex-col min-h-0"
            style={{ background: "transparent", containerType: "inline-size" }}
          >
            <Outlet />
          </SidebarInset>
        </SidebarLayout>
      </div>
    </SidebarProvider>
  );
}
