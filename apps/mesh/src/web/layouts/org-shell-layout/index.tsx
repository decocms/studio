/**
 * Org Shell Layout
 *
 * Shared parent for `/$org/` (home) and `/$org/$taskId` (chat). Owns the
 * sidebar + toolbar shell + ChatPrefsProvider. The org-wide tasks panel lives
 * here, outside child-route Suspense, so it stays mounted while the active
 * task/chat content switches.
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
import { Loading01, Menu01 } from "@untitledui/icons";
import { Outlet, useParams } from "@tanstack/react-router";
import { StudioSidebar, StudioSidebarMobile } from "@/web/components/sidebar";
import { ChatPrefsProvider } from "@/web/components/chat/context";
import { ThreadEventsBridge } from "@/web/components/chat/task";
import { TasksPanelStateProvider } from "@/web/hooks/use-tasks-panel-state";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { TasksPanelColumn } from "@/web/layouts/agent-shell-layout/tasks-panel-column";
import { TasksPanel } from "@/web/layouts/tasks-panel";

function RouteFallback() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loading01 size={20} className="animate-spin text-muted-foreground" />
    </div>
  );
}

function MobileHomeToolbar() {
  const { setOpenMobile, openMobile } = useSidebar();
  return (
    <>
      <div className="shrink-0 flex items-center px-2 h-12 bg-background border-b border-border">
        <button
          type="button"
          onClick={() => setOpenMobile(true)}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/60 hover:bg-accent hover:text-foreground transition-colors"
          aria-label="Open menu"
        >
          <Menu01 size={20} />
        </button>
      </div>
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          side="left"
          hideCloseButton
          className="w-[calc(100vw-3rem)] sm:max-w-md! p-0"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-full">
            <div
              className="w-14 shrink-0 bg-sidebar flex flex-col items-center border-r border-border overflow-y-auto group/sidebar"
              data-state="collapsed"
            >
              <StudioSidebarMobile onClose={() => setOpenMobile(false)} />
            </div>
            <div className="flex-1 min-w-0 overflow-hidden">
              <TasksPanel />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export default function OrgShellLayout() {
  const isMobile = useIsMobile();
  const params = useParams({ strict: false }) as { taskId?: string };
  const hasTaskRoute = Boolean(params.taskId);

  return (
    <SidebarProvider defaultOpen={false}>
      <div className="flex flex-col h-dvh overflow-hidden">
        <SidebarLayout
          className="flex-1 bg-sidebar"
          style={
            {
              "--sidebar-width-icon": "3.5rem",
            } as Record<string, string>
          }
        >
          <StudioSidebar />
          <SidebarInset
            className="flex flex-col"
            style={{
              background: "transparent",
              containerType: "inline-size",
            }}
          >
            <ChatPrefsProvider>
              <TasksPanelStateProvider>
                <ThreadEventsBridge />
                {isMobile ? (
                  <>
                    {!hasTaskRoute && <MobileHomeToolbar />}
                    <Suspense fallback={<RouteFallback />}>
                      <Outlet />
                    </Suspense>
                  </>
                ) : (
                  <Toolbar>
                    <Toolbar.Header>
                      <Toolbar.LeftColumn>
                        <Toolbar.Nav />
                        <Toolbar.TogglesSlot />
                      </Toolbar.LeftColumn>
                      <Toolbar.CenterSlot />
                      <Toolbar.RightColumn>
                        <Toolbar.TabsSlot />
                        <Toolbar.RightSlot />
                      </Toolbar.RightColumn>
                    </Toolbar.Header>
                    <div className="flex-1 min-h-0 flex flex-row">
                      <TasksPanelColumn />
                      <Suspense fallback={<RouteFallback />}>
                        <Outlet />
                      </Suspense>
                    </div>
                  </Toolbar>
                )}
              </TasksPanelStateProvider>
            </ChatPrefsProvider>
          </SidebarInset>
        </SidebarLayout>
      </div>
    </SidebarProvider>
  );
}
