import { useEffect, useState } from "react";
import { Chat } from "@/web/components/chat/index";
import { ChatPanel } from "@/web/components/chat/side-panel-chat";
import { CreateProjectDialog } from "@/web/components/create-project-dialog";
import { KeyboardShortcutsDialog } from "@/web/components/keyboard-shortcuts-dialog";
import { isModKey } from "@/web/lib/keyboard-shortcuts";
import { MeshSidebar } from "@/web/components/sidebar";
import { SplashScreen } from "@/web/components/splash-screen";
import { MeshUserMenu } from "@/web/components/user-menu.tsx";
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import RequiredAuthLayout from "@/web/layouts/required-auth-layout";
import { authClient } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { Drawer, DrawerContent } from "@deco/ui/components/drawer.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@deco/ui/components/resizable.tsx";
import {
  SidebarInset,
  SidebarLayout,
  SidebarProvider,
} from "@deco/ui/components/sidebar.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { MessageTextCircle02 } from "@untitledui/icons";
import {
  ProjectContextProvider,
  ProjectContextProviderProps,
} from "@decocms/mesh-sdk";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, useParams, useRouterState } from "@tanstack/react-router";
import { PropsWithChildren, Suspense, useTransition } from "react";
import { KEYS } from "../lib/query-keys";

/**
 * This component persists the width of the chat panel across reloads.
 * Also, it's important to keep it like this to avoid unnecessary re-renders.
 */
function PersistentResizablePanel({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  const [_isPending, startTransition] = useTransition();
  const [chatPanelWidth, setChatPanelWidth] = useLocalStorage(
    LOCALSTORAGE_KEYS.decoChatPanelWidth(),
    30,
  );

  const handleResize = (size: number) =>
    startTransition(() => setChatPanelWidth(size));

  return (
    <ResizablePanel
      defaultSize={chatPanelWidth}
      minSize={20}
      className={cn("min-w-0", className)}
      onResize={handleResize}
    >
      {children}
    </ResizablePanel>
  );
}

/**
 * This component persists the open state of the sidebar across reloads.
 * Also, it's important to keep it like this to avoid unnecessary re-renders.
 */
function PersistentSidebarProvider({ children }: PropsWithChildren) {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useLocalStorage(
    LOCALSTORAGE_KEYS.sidebarOpen(),
    true,
  );

  return (
    <SidebarProvider
      open={isMobile ? true : sidebarOpen}
      onOpenChange={setSidebarOpen}
    >
      {children}
    </SidebarProvider>
  );
}

function MobileChatFAB({
  onClick,
  isOpen,
}: {
  onClick: () => void;
  isOpen: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "fixed bottom-4 right-4 z-40 flex size-12 items-center justify-center rounded-full shadow-lg transition-colors",
        "bg-primary text-primary-foreground hover:bg-primary/90",
        isOpen && "bg-accent text-foreground",
      )}
      aria-label="Toggle chat"
    >
      <MessageTextCircle02 size={20} />
    </button>
  );
}

function ShellLayoutInner({
  isHomeRoute,
  onCreateProject,
}: {
  isHomeRoute: boolean;
  onCreateProject: () => void;
}) {
  const [chatOpen, setChatOpen] = useDecoChatOpen();
  const isMobile = useIsMobile();
  const [chatPanelWidth] = useLocalStorage(
    LOCALSTORAGE_KEYS.decoChatPanelWidth(),
    30,
  );

  return (
    <SidebarLayout
      className="flex-1 bg-sidebar"
      style={
        {
          "--sidebar-width": "13.5rem",
          "--sidebar-width-mobile": "11rem",
          "--chat-panel-w": `${chatPanelWidth}cqi`,
        } as Record<string, string>
      }
    >
      <MeshSidebar onCreateProject={onCreateProject} />
      {/* SidebarInset: transparent so bg-sidebar from SidebarLayout shows
          through the rounded corners of the inner card */}
      <SidebarInset
        className="pt-1.5"
        style={{ background: "transparent", containerType: "inline-size" }}
      >
        <ResizablePanelGroup
          direction="horizontal"
          className="h-full"
          style={{ overflow: "visible" }}
        >
          {/* overflow:visible overrides the library's inline overflow:hidden
              so the card's thin border-l at x=0 isn't clipped at the boundary */}
          <ResizablePanel
            className="min-w-0 flex flex-col"
            style={{ overflow: "visible" }}
          >
            <div
              className={cn(
                "flex flex-col flex-1 min-h-0 bg-card overflow-hidden",
                "border-t border-l border-sidebar-border",
                "rounded-tl-[0.75rem]",
                "transition-[border-radius] duration-200 ease-[var(--ease-out-quart)]",
                !isMobile && chatOpen && "rounded-tr-[0.75rem] border-r",
                isMobile && "rounded-tr-[0.75rem] border-r",
              )}
            >
              <div className="flex-1 overflow-hidden">
                <Outlet />
              </div>
            </div>
          </ResizablePanel>

          {/* Desktop: Chat card as resizable side panel */}
          {!isHomeRoute && !isMobile && (
            <>
              <ResizableHandle className="bg-sidebar" />
              <PersistentResizablePanel
                className={cn(
                  "transition-[max-width] duration-200 ease-[var(--ease-out-quart)] overflow-hidden",
                  chatOpen
                    ? "max-w-[var(--chat-panel-w)] bg-sidebar"
                    : "max-w-0",
                )}
              >
                <div className="h-full min-w-[var(--chat-panel-w)] pl-1.5 pr-1.5 pb-1.5">
                  <div className="h-full bg-background rounded-[0.75rem] overflow-hidden border border-sidebar-border shadow-sm">
                    <ChatPanel />
                  </div>
                </div>
              </PersistentResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </SidebarInset>

      {/* Mobile: FAB + bottom Drawer for chat */}
      {!isHomeRoute && isMobile && (
        <>
          <MobileChatFAB
            onClick={() => setChatOpen((prev) => !prev)}
            isOpen={chatOpen}
          />
          <Drawer open={chatOpen} onOpenChange={setChatOpen} direction="bottom">
            <DrawerContent className="h-[95dvh] max-h-[95dvh]">
              <ChatPanel />
            </DrawerContent>
          </Drawer>
        </>
      )}
    </SidebarLayout>
  );
}

function ShellLayoutContent() {
  const { org } = useParams({ strict: false });
  const routerState = useRouterState();
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (isModKey(e) && e.code === "KeyK") {
        e.preventDefault();
        setShortcutsDialogOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Check if we're on the org home route (/$org)
  const isHomeRoute =
    routerState.location.pathname === `/${org}` ||
    routerState.location.pathname === `/${org}/`;

  const { data: projectContext } = useSuspenseQuery({
    queryKey: KEYS.activeOrganization(org),
    queryFn: async () => {
      if (!org) {
        return null;
      }

      const { data } = await authClient.organization.setActive({
        organizationSlug: org,
      });

      // Persist for fast redirect on next login (read by homeRoute beforeLoad)
      // Only write on success to avoid caching an invalid slug
      if (data) {
        localStorage.setItem(LOCALSTORAGE_KEYS.lastOrgSlug(), org);
      }

      return {
        org: data,
        // Provide a minimal project stub at shell level.
        // The org-layout and virtual-mcp-layout will override with proper context.
        project: {
          id: "_org",
          slug: "_org",
          isOrgAdmin: true,
        },
      } as ProjectContextProviderProps;
    },
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (!projectContext) {
    return (
      <div className="min-h-screen bg-background">
        <header className="h-12 flex items-center justify-end px-4 border-b border-border">
          <div className="w-fit">
            <MeshUserMenu />
          </div>
        </header>
        <Outlet />
      </div>
    );
  }

  // If org parameter exists but organization is invalid/doesn't exist, redirect to home
  if (!projectContext.org) {
    // Prevent infinite redirect loop - only redirect if not already at home
    if (window.location.pathname !== "/") {
      window.location.href = "/";
    }
    return null;
  }

  return (
    <ProjectContextProvider {...projectContext}>
      <PersistentSidebarProvider>
        <div className="flex flex-col h-dvh overflow-hidden">
          <Chat.Provider>
            <ShellLayoutInner
              isHomeRoute={isHomeRoute}
              onCreateProject={() => setCreateProjectDialogOpen(true)}
            />
          </Chat.Provider>
        </div>
      </PersistentSidebarProvider>

      {/* Create Project Dialog */}
      <CreateProjectDialog
        open={createProjectDialogOpen}
        onOpenChange={setCreateProjectDialogOpen}
      />

      {/* Keyboard Shortcuts Dialog */}
      <KeyboardShortcutsDialog
        open={shortcutsDialogOpen}
        onOpenChange={setShortcutsDialogOpen}
      />
    </ProjectContextProvider>
  );
}

export default function ShellLayout() {
  return (
    <RequiredAuthLayout>
      <Suspense fallback={<SplashScreen />}>
        <ShellLayoutContent />
      </Suspense>
    </RequiredAuthLayout>
  );
}
