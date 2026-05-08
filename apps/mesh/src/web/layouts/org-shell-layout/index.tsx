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
} from "@deco/ui/components/sidebar.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { Loading01 } from "@untitledui/icons";
import { Outlet, useParams } from "@tanstack/react-router";
import { StudioSidebar } from "@/web/components/sidebar";
import { ChatPrefsProvider } from "@/web/components/chat/context";
import { TasksPanelStateProvider } from "@/web/hooks/use-tasks-panel-state";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { TasksPanelColumn } from "@/web/layouts/agent-shell-layout/tasks-panel-column";

function RouteFallback() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loading01 size={20} className="animate-spin text-muted-foreground" />
    </div>
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
                {isMobile ? (
                  <Suspense fallback={<RouteFallback />}>
                    <Outlet />
                  </Suspense>
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
                      {hasTaskRoute && <TasksPanelColumn />}
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
