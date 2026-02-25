import { useState } from "react";
import { Chat, useChat } from "@/web/components/chat/index";
import { ChatPanel } from "@/web/components/chat/side-panel-chat";
import { CreateProjectDialog } from "@/web/components/create-project-dialog";
import { GitPanel } from "@/web/components/git-panel";
import { MeshSidebar } from "@/web/components/sidebar";
import { SplashScreen } from "@/web/components/splash-screen";
import { MeshUserMenu } from "@/web/components/user-menu.tsx";
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { useGitPanel } from "@/web/hooks/use-git-panel";
import { useProjectBash } from "@/web/hooks/use-project-bash";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import RequiredAuthLayout from "@/web/layouts/required-auth-layout";
import { authClient } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
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
import {
  ChatBridgeProvider,
  ORG_ADMIN_PROJECT_SLUG,
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
 * Git panel overlay — slides in from the right as a fixed-width panel.
 * Rendered inside ProjectContextProvider so it has access to connections.
 */
/**
 * The git panel content — only renders internals when connection is available.
 */
function GitPanelContent({ onClose }: { onClose: () => void }) {
  const { client, connectionId, connectionUrl } = useProjectBash();

  if (!client || !connectionId) return null;

  return (
    <GitPanel
      client={client}
      connectionId={connectionId}
      connectionUrl={connectionUrl}
      onClose={onClose}
    />
  );
}

function ShellLayoutInner({
  isStudio,
  isHomeRoute,
  onCreateProject,
}: {
  isStudio: boolean;
  isHomeRoute: boolean;
  onCreateProject: () => void;
}) {
  const [chatOpen] = useDecoChatOpen();
  const [gitPanelOpen, setGitPanelOpen] = useGitPanel();
  const [chatPanelWidth] = useLocalStorage(
    LOCALSTORAGE_KEYS.decoChatPanelWidth(),
    30,
  );
  const [preferences] = usePreferences();

  return (
    <SidebarLayout
      className="flex-1 bg-sidebar"
      data-studio={
        isStudio && preferences.experimental_projects ? "" : undefined
      }
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
          {/* Main content card */}
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
                (chatOpen || gitPanelOpen) && "rounded-tr-[0.75rem] border-r",
              )}
            >
              <div className="flex-1 overflow-hidden">
                <Outlet />
              </div>
            </div>
          </ResizablePanel>

          {/* Git panel card — slides in/out */}
          <ResizableHandle className="bg-sidebar" />
          <ResizablePanel
            defaultSize={25}
            minSize={gitPanelOpen ? 20 : 0}
            className={cn(
              "transition-[max-width] duration-200 ease-[var(--ease-out-quart)] overflow-hidden",
              gitPanelOpen ? "max-w-[480px] bg-sidebar" : "max-w-0",
            )}
          >
            <div className="h-full pl-1.5 pb-1.5">
              <div className="h-full bg-background rounded-[0.75rem] overflow-hidden border border-sidebar-border shadow-sm">
                <Suspense>
                  <GitPanelContent onClose={() => setGitPanelOpen(false)} />
                </Suspense>
              </div>
            </div>
          </ResizablePanel>

          {/* Chat card — slides in/out */}
          {!isHomeRoute && (
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
    </SidebarLayout>
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
        <header className="h-12 flex items-center justify-end px-4 border-b border-border">
          <MeshUserMenu />
        </header>
        <Outlet />
      </div>
    );
  }

  if (!projectContext.org) {
    if (window.location.pathname !== "/") {
      window.location.href = "/";
    }
    return null;
  }

  const contextWithCurrentProject = {
    ...projectContext,
    project: {
      ...projectContext.project,
      slug: projectSlug,
      isOrgAdmin: projectSlug === ORG_ADMIN_PROJECT_SLUG,
    },
  };

  const isStudio = projectSlug === ORG_ADMIN_PROJECT_SLUG;

  return (
    <ProjectContextProvider {...contextWithCurrentProject}>
      <PersistentSidebarProvider>
        <div className="flex flex-col h-screen overflow-hidden">
          <Chat.Provider>
            <ChatBridgeWrapper>
              <ShellLayoutInner
                isStudio={isStudio}
                isHomeRoute={isHomeRoute}
                onCreateProject={() => setCreateProjectDialogOpen(true)}
              />
            </ChatBridgeWrapper>
          </Chat.Provider>
        </div>
      </PersistentSidebarProvider>

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
