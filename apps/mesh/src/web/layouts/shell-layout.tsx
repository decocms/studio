import { useState } from "react";
import { Chat, useChat } from "@/web/components/chat/index";
import { ChatPanel } from "@/web/components/chat/side-panel-chat";
import { CreateProjectDialog } from "@/web/components/create-project-dialog";
import { MeshSidebar } from "@/web/components/sidebar";
import { MeshOrgSwitcher } from "@/web/components/org-switcher";
import { SplashScreen } from "@/web/components/splash-screen";
import { ProjectTopbar } from "@/web/components/topbar/project-topbar";
import { TopbarPortalProvider } from "@decocms/mesh-sdk/plugins";
import { MeshUserMenu } from "@/web/components/user-menu";
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import RequiredAuthLayout from "@/web/layouts/required-auth-layout";
import { authClient } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { AppTopbar } from "@deco/ui/components/app-topbar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@deco/ui/components/resizable.tsx";
import { SidebarToggleButton } from "@deco/ui/components/sidebar-toggle-button.tsx";
import {
  SidebarInset,
  SidebarLayout,
  SidebarProvider,
} from "@deco/ui/components/sidebar.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import {
  ChatBridgeProvider,
  ORG_ADMIN_PROJECT_SLUG,
  ProjectContextProvider,
  ProjectContextProviderProps,
} from "@decocms/mesh-sdk";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, useParams, useRouterState } from "@tanstack/react-router";
import { MessageChatSquare } from "@untitledui/icons";
import { PropsWithChildren, Suspense, useRef, useTransition } from "react";
import { KEYS } from "../lib/query-keys";

function Topbar({
  showSidebarToggle = false,
  showOrgSwitcher = false,
  showDecoChat = false,
  disableDecoChat = false,
}: {
  showSidebarToggle?: boolean;
  showOrgSwitcher?: boolean;
  showDecoChat?: boolean;
  disableDecoChat?: boolean;
}) {
  const [isOpen, setChatOpen] = useDecoChatOpen();
  const prevDisableRef = useRef(disableDecoChat);

  // Close chat panel if disabled (synchronous check)
  if (disableDecoChat && isOpen && prevDisableRef.current !== disableDecoChat) {
    setChatOpen(false);
  }
  prevDisableRef.current = disableDecoChat;

  const toggleChat = () => {
    if (!disableDecoChat) {
      setChatOpen((prev) => !prev);
    }
  };

  return (
    <AppTopbar>
      {showSidebarToggle && (
        <AppTopbar.Sidebar>
          <SidebarToggleButton />
        </AppTopbar.Sidebar>
      )}
      <AppTopbar.Left>
        {showOrgSwitcher && (
          <Suspense fallback={<MeshOrgSwitcher.Skeleton />}>
            <MeshOrgSwitcher />
          </Suspense>
        )}
      </AppTopbar.Left>
      <AppTopbar.Right className="gap-2">
        {showDecoChat && !disableDecoChat && (
          <Button
            size="sm"
            variant="default"
            onClick={toggleChat}
            className="h-7 gap-2"
          >
            <MessageChatSquare size={16} />
            Chat
          </Button>
        )}
        <MeshUserMenu />
      </AppTopbar.Right>
    </AppTopbar>
  );
}

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
  const [sidebarOpen, setSidebarOpen] = useLocalStorage(
    LOCALSTORAGE_KEYS.sidebarOpen(),
    true,
  );

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      {children}
    </SidebarProvider>
  );
}

/**
 * This component renders the chat panel and the main content.
 * It's important to keep it like this to avoid unnecessary re-renders.
 */
function ChatPanels({ disableChat = false }: { disableChat?: boolean }) {
  const [chatOpen] = useDecoChatOpen();
  const showChat = chatOpen && !disableChat;

  return (
    <ResizablePanelGroup direction="horizontal">
      <ResizablePanel className="bg-background">
        <Outlet />
      </ResizablePanel>
      <ResizableHandle
        withHandle={showChat}
        className={cn(!showChat && "hidden")}
      />
      <PersistentResizablePanel
        className={cn(showChat ? "max-w-none" : "max-w-0")}
      >
        <ChatPanel />
      </PersistentResizablePanel>
    </ResizablePanelGroup>
  );
}

/**
 * Bridges the chat context to packages via ChatBridgeProvider.
 * Must be rendered inside Chat.Provider.
 */
function ChatBridgeWrapper({ children }: PropsWithChildren) {
  const { sendMessage } = useChat();
  const [, setChatOpen] = useDecoChatOpen();

  const handleSend = (text: string) => {
    const doc = {
      type: "doc" as const,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    };
    setChatOpen(true);
    void sendMessage(doc);
  };

  return (
    <ChatBridgeProvider
      sendMessage={handleSend}
      openChat={() => setChatOpen(true)}
    >
      {children}
    </ChatBridgeProvider>
  );
}

function ShellLayoutContent() {
  const { org, project } = useParams({ strict: false });
  const routerState = useRouterState();
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);

  // Check if we're on the project home route (/$org/$project)
  const isHomeRoute =
    routerState.location.pathname === `/${org}/${project}` ||
    routerState.location.pathname === `/${org}/${project}/`;

  // Use project slug from URL params, fallback to org-admin
  const projectSlug = project ?? ORG_ADMIN_PROJECT_SLUG;

  const { data: projectContext } = useSuspenseQuery({
    queryKey: KEYS.activeOrganization(org),
    queryFn: async () => {
      if (!org) {
        return null;
      }

      const { data } = await authClient.organization.setActive({
        organizationSlug: org,
      });

      return {
        org: data,
        // Project slug comes from URL param, actual project data is fetched in project-layout
        project: {
          slug: projectSlug,
          isOrgAdmin: projectSlug === ORG_ADMIN_PROJECT_SLUG,
        },
      } as ProjectContextProviderProps;
    },
    gcTime: Infinity,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  if (!projectContext) {
    return (
      <div className="min-h-screen bg-background">
        <Topbar />
        <div className="pt-12">
          <Outlet />
        </div>
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

  // Update project context with current project slug from URL
  const contextWithCurrentProject = {
    ...projectContext,
    project: {
      ...projectContext.project,
      slug: projectSlug,
      isOrgAdmin: projectSlug === ORG_ADMIN_PROJECT_SLUG,
    },
  };

  return (
    <ProjectContextProvider {...contextWithCurrentProject}>
      <PersistentSidebarProvider>
        <div
          className="flex flex-col h-screen"
          style={
            {
              "--project-topbar-height":
                projectSlug === ORG_ADMIN_PROJECT_SLUG ? "0px" : "48px",
            } as React.CSSProperties
          }
        >
          <style>{`
            [data-slot="sidebar-container"] {
              top: 0 !important;
            }
            [data-slot="sidebar-inner"] {
              padding-top: 0 !important;
            }
          `}</style>
          <Chat.Provider>
            <ChatBridgeWrapper>
              <SidebarLayout
                className="flex-1 bg-sidebar"
                style={
                  {
                    "--sidebar-width": "13rem",
                    "--sidebar-width-mobile": "11rem",
                  } as Record<string, string>
                }
              >
                <MeshSidebar
                  onCreateProject={() => setCreateProjectDialogOpen(true)}
                />
                <SidebarInset className="flex flex-col">
                  <TopbarPortalProvider>
                    <ProjectTopbar />
                    <div className="flex-1 overflow-hidden">
                      <ChatPanels disableChat={isHomeRoute} />
                    </div>
                  </TopbarPortalProvider>
                </SidebarInset>
              </SidebarLayout>
            </ChatBridgeWrapper>
          </Chat.Provider>
        </div>
      </PersistentSidebarProvider>

      {/* Create Project Dialog */}
      <CreateProjectDialog
        open={createProjectDialogOpen}
        onOpenChange={setCreateProjectDialogOpen}
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
