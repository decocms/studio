import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Chat, useChatTask } from "@/web/components/chat/index";
import { ChatPanel } from "@/web/components/chat/side-panel-chat";
import { TasksSidePanel } from "@/web/components/chat/side-panel-tasks";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { KeyboardShortcutsDialog } from "@/web/components/keyboard-shortcuts-dialog";
import { isMac, isModKey } from "@/web/lib/keyboard-shortcuts";
import { MeshSidebar, MeshSidebarMobile } from "@/web/components/sidebar";
import {
  SettingsSidebar,
  SettingsSidebarMobile,
} from "@/web/layouts/settings-layout";
import { MeshUserMenu } from "@/web/components/user-menu.tsx";
import {
  PanelContextProvider,
  useChatPanel,
} from "@/web/contexts/panel-context";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import RequiredAuthLayout from "@/web/layouts/required-auth-layout";
import { authClient } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import {
  type ImperativePanelHandle,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@deco/ui/components/resizable.tsx";
import {
  SidebarInset,
  SidebarLayout,
  SidebarProvider,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Sheet, SheetContent, SheetTitle } from "@deco/ui/components/sheet.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import {
  Browser,
  ChevronLeft,
  ChevronRight,
  LayoutLeft,
  Edit05,
  Loading01,
  Menu01,
  MessageTextCircle02,
} from "@untitledui/icons";
import {
  getWellKnownDecopilotVirtualMCP,
  ProjectContextProvider,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, useMatch, useRouterState } from "@tanstack/react-router";
import { PropsWithChildren, Suspense, useTransition } from "react";
import { KEYS } from "../lib/query-keys";
import { useOrgSsoStatus } from "../hooks/use-org-sso";
import { useStatusSounds } from "../hooks/use-status-sounds";
import { useSound } from "../hooks/use-sound";
import { switch005Sound } from "@deco/ui/lib/switch-005.ts";
import { SsoRequiredScreen } from "../components/sso-required-screen";
import { VirtualMCPProvider } from "@/web/providers/virtual-mcp-provider";
import { usePinnedViewLayout } from "@/web/hooks/use-pinned-view-layout";

/**
 * This component persists the width of the chat panel across reloads.
 * Also, it's important to keep it like this to avoid unnecessary re-renders.
 */
function PersistentResizablePanel({
  children,
  panelRef,
  defaultCollapsed,
  defaultFullWidth,
  defaultSizeOverride,
  onCollapse,
  onExpand,
}: PropsWithChildren<{
  panelRef: React.RefObject<ImperativePanelHandle | null>;
  defaultCollapsed: boolean;
  defaultFullWidth?: boolean;
  defaultSizeOverride?: number;
  onCollapse: () => void;
  onExpand: () => void;
}>) {
  const [_isPending, startTransition] = useTransition();
  const [chatPanelWidth, setChatPanelWidth] = useLocalStorage(
    LOCALSTORAGE_KEYS.decoChatPanelWidth(),
    25,
  );

  const handleResize = (size: number) =>
    startTransition(() => {
      if (size > 0 && !defaultFullWidth) setChatPanelWidth(size);
    });

  const savedWidth = Math.min(chatPanelWidth, 35);
  const defaultSize =
    defaultSizeOverride ??
    (defaultCollapsed ? 0 : defaultFullWidth ? 100 : savedWidth);

  return (
    <ResizablePanel
      ref={panelRef}
      defaultSize={defaultSize}
      minSize={20}
      collapsible={true}
      collapsedSize={0}
      onCollapse={onCollapse}
      onExpand={onExpand}
      className="min-w-0 overflow-hidden bg-sidebar"
      onResize={handleResize}
      order={3}
    >
      {children}
    </ResizablePanel>
  );
}

/**
 * Collapsible tasks sidebar panel. Fixed minimum width of 22% — not persisted.
 */
function TasksResizablePanel({
  children,
  panelRef,
  defaultCollapsed,
  onCollapse,
  onExpand,
}: PropsWithChildren<{
  panelRef: React.RefObject<ImperativePanelHandle | null>;
  defaultCollapsed: boolean;
  onCollapse?: () => void;
  onExpand?: () => void;
}>) {
  return (
    <ResizablePanel
      ref={panelRef}
      defaultSize={defaultCollapsed ? 0 : 22}
      minSize={22}
      collapsible={true}
      collapsedSize={0}
      onCollapse={onCollapse}
      onExpand={onExpand}
      className="min-w-0 overflow-hidden bg-sidebar"
      order={1}
    >
      {children}
    </ResizablePanel>
  );
}

type OrgSettingsPayload = {
  organizationId: string;
  enabled_plugins?: string[] | null;
};

/**
 * Single ProjectContextProvider for the entire shell.
 * Fetches org settings (enabledPlugins) and provides a complete project context.
 * Agent routes override this via VirtualMCPProvider.
 */
function ShellProjectProvider({
  org,
  children,
}: {
  org: NonNullable<Parameters<typeof ProjectContextProvider>[0]["org"]>;
  children: React.ReactNode;
}) {
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data: orgSettings } = useSuspenseQuery({
    queryKey: KEYS.organizationSettings(org.id),
    queryFn: async () => {
      const result = await client.callTool({
        name: "ORGANIZATION_SETTINGS_GET",
        arguments: {},
      });
      const payload =
        (result as { structuredContent?: unknown }).structuredContent ?? result;
      return (payload ?? {}) as OrgSettingsPayload;
    },
    staleTime: 60_000,
  });

  const project = {
    id: org.id,
    organizationId: org.id,
    slug: "_org",
    name: org.name,
    enabledPlugins: orgSettings?.enabled_plugins ?? null,
    ui: null,
  };

  return (
    <ProjectContextProvider org={org} project={project}>
      {children}
    </ProjectContextProvider>
  );
}

function PersistentSidebarProvider({
  children,
  defaultOpen,
}: PropsWithChildren<{ defaultOpen?: boolean }>) {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>{children}</SidebarProvider>
  );
}

function VirtualMCPScope({
  virtualMcpId,
  children,
}: {
  virtualMcpId?: string;
  children: React.ReactNode;
}) {
  if (virtualMcpId) {
    return (
      <VirtualMCPProvider virtualMcpId={virtualMcpId}>
        {children}
      </VirtualMCPProvider>
    );
  }
  return <>{children}</>;
}

function MobileToolbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  return (
    <div className="shrink-0 flex items-center justify-between px-3 h-12 bg-background border-b border-border">
      <button
        type="button"
        onClick={onOpenSidebar}
        className="flex size-8 items-center justify-center rounded-md text-foreground/60 hover:bg-accent hover:text-foreground transition-colors"
        aria-label="Open menu"
      >
        <Menu01 size={20} />
      </button>
    </div>
  );
}

function ToolbarBreadcrumb() {
  const routerState = useRouterState();
  const orgMatch = useMatch({ from: "/shell/$org", shouldThrow: false });
  const org = orgMatch?.params.org;

  const isAgentsList =
    org && routerState.location.pathname === `/${org}/agents`;

  if (isAgentsList) {
    return (
      <div className="flex items-center min-w-0 ml-1.5">
        <span className="text-sm font-medium text-sidebar-foreground">
          Agents
        </span>
      </div>
    );
  }

  return null;
}

/**
 * Reads taskId from ChatTaskContext and wraps children in ActiveTaskProvider
 * inside a Suspense + ErrorBoundary boundary.
 */
function ActiveTaskBoundary({
  children,
  variant,
}: {
  children?: React.ReactNode;
  variant?: "home" | "default";
}) {
  const { taskId } = useChatTask();
  return (
    <ErrorBoundary
      fallback={
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Something went wrong loading the chat. Try refreshing.
        </div>
      }
    >
      <Suspense fallback={<Chat.Skeleton />}>
        <Chat.ActiveTaskProvider taskId={taskId}>
          {children ?? <ChatPanel variant={variant} />}
        </Chat.ActiveTaskProvider>
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * Bridges createTask from inside Chat.Provider to the toolbar ref
 * so the ⇧⌘S shortcut and sidebar button can create tasks.
 */
function NewTaskBridge({
  onNewTaskRef,
}: {
  onNewTaskRef: React.MutableRefObject<(() => void) | null>;
}) {
  const { createTask } = useChatTask();
  const [chatOpen, setChatOpen] = useChatPanel();
  useLayoutEffect(() => {
    onNewTaskRef.current = () => {
      createTask();
      if (!chatOpen) setChatOpen(true);
    };
    return () => {
      onNewTaskRef.current = null;
    };
  });
  return null;
}

/**
 * Resolves whether the main panel should render based on ?main param and entity's defaultMainView.
 * Keyed by virtualMcpId so the entire panel group remounts per agent with correct layout.
 */
function AgentPanelGroup({
  agentVirtualMcpId,
  isAgentRoute,
  isOrgHome,
  showThreePanels,
  tasksVirtualMcpId,
  tasksPanelRef,
  mainPanelRef,
  chatPanelRef,
  chatDefaultCollapsed,
  mainDefaultCollapsed,
  setTasksOpen,
  setMainOpen,
  setChatOpen,
}: {
  agentVirtualMcpId: string | undefined;
  isAgentRoute: boolean;
  isOrgHome: boolean;
  showThreePanels: boolean;
  tasksVirtualMcpId: string | undefined;
  tasksPanelRef: React.RefObject<ImperativePanelHandle | null>;
  mainPanelRef: React.RefObject<ImperativePanelHandle | null>;
  chatPanelRef: React.RefObject<ImperativePanelHandle | null>;
  chatDefaultCollapsed: boolean;
  mainDefaultCollapsed: boolean;
  setTasksOpen: (open: boolean) => void;
  setMainOpen: (open: boolean) => void;
  setChatOpen: (open: boolean) => void;
}) {
  return (
    <ResizablePanelGroup
      key={`${agentVirtualMcpId ?? "none"}-${mainDefaultCollapsed}-${chatDefaultCollapsed}`}
      direction="horizontal"
      className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0"
      style={{ overflow: "visible" }}
    >
      {showThreePanels && (
        <>
          <TasksResizablePanel
            panelRef={tasksPanelRef}
            defaultCollapsed={!isAgentRoute}
            onCollapse={() => setTasksOpen(false)}
            onExpand={() => setTasksOpen(true)}
          >
            <div className="h-full p-0.5 overflow-hidden">
              <div className="h-full bg-background rounded-[0.75rem] overflow-hidden border border-sidebar-border shadow-sm">
                <TasksSidePanel
                  virtualMcpId={tasksVirtualMcpId}
                  hideProjectHeader={isOrgHome}
                  showAutomations={!isOrgHome}
                />
              </div>
            </div>
          </TasksResizablePanel>
          <ResizableHandle className="bg-sidebar" />
        </>
      )}

      {!isOrgHome && (
        <ResizablePanel
          ref={mainPanelRef}
          className="min-w-0 flex flex-col"
          order={2}
          defaultSize={mainDefaultCollapsed ? 0 : undefined}
          style={{ overflow: "visible" }}
          collapsible={isAgentRoute}
          collapsedSize={0}
          minSize={isAgentRoute ? 20 : undefined}
          onCollapse={() => setMainOpen(false)}
          onExpand={() => setMainOpen(true)}
        >
          <div className="h-full p-0.5 overflow-hidden">
            <div
              className={cn(
                "flex flex-col h-full min-h-0 bg-card overflow-hidden",
                "border border-sidebar-border shadow-sm",
                "transition-[border-radius] duration-200 ease-[var(--ease-out-quart)]",
                "rounded-[0.75rem]",
              )}
            >
              <Suspense
                fallback={
                  <div className="flex-1 flex items-center justify-center">
                    <Loading01
                      size={20}
                      className="animate-spin text-muted-foreground"
                    />
                  </div>
                }
              >
                <div className="flex-1 overflow-hidden rounded-[inherit]">
                  <Outlet />
                </div>
              </Suspense>
            </div>
          </div>
        </ResizablePanel>
      )}

      {showThreePanels && (
        <>
          {!isOrgHome && <ResizableHandle className="bg-sidebar" />}
          <PersistentResizablePanel
            key={
              isOrgHome
                ? "chat-home"
                : mainDefaultCollapsed
                  ? "chat-no-main"
                  : chatDefaultCollapsed
                    ? "chat-hidden"
                    : "chat-default"
            }
            panelRef={chatPanelRef}
            defaultCollapsed={chatDefaultCollapsed}
            defaultFullWidth={isOrgHome}
            defaultSizeOverride={mainDefaultCollapsed ? 78 : undefined}
            onCollapse={() => setChatOpen(false)}
            onExpand={() => setChatOpen(true)}
          >
            <div className="h-full p-0.5">
              <div className="h-full bg-background rounded-[0.75rem] overflow-hidden border border-sidebar-border shadow-sm">
                <ActiveTaskBoundary variant={isOrgHome ? "home" : undefined} />
              </div>
            </div>
          </PersistentResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

function ShellLayoutInner({
  isAgentRoute,
  isOrgHome,
  isSettingsRoute,
}: {
  isAgentRoute: boolean;
  isOrgHome: boolean;
  isSettingsRoute: boolean;
}) {
  const [chatOpen, setChatOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [mainOpen, setMainOpen] = useState(true);
  const isMobile = useIsMobile();
  const { org } = useProjectContext();

  // Org-wide SSE sound notifications
  useStatusSounds(org.id);

  // Extract virtualMcpId from route for agent context
  const agentsMatch = useMatch({
    from: "/shell/$org/$virtualMcpId",
    shouldThrow: false,
  });
  const agentVirtualMcpId = agentsMatch?.params.virtualMcpId;

  const { chatDefaultCollapsed, mainDefaultCollapsed } = usePinnedViewLayout(
    agentVirtualMcpId,
    isAgentRoute,
  );

  const showThreePanels = isAgentRoute || isOrgHome;

  // Compute virtualMcpId for the tasks panel:
  //   - org home → decopilot agent
  //   - agent route → the current agent
  //   - other routes → undefined (global tasks view)
  const tasksVirtualMcpId = isOrgHome
    ? getWellKnownDecopilotVirtualMCP(org.id).id
    : agentVirtualMcpId;

  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const tasksPanelRef = useRef<ImperativePanelHandle>(null);
  const mainPanelRef = useRef<ImperativePanelHandle>(null);
  const [chatPanelWidth] = useLocalStorage(
    LOCALSTORAGE_KEYS.decoChatPanelWidth(),
    25,
  );

  // --- Toggle handlers with all-panels-collapsed guard ---
  // Use imperative panel API to resize panels directly.
  // The onCollapse/onExpand callbacks on each panel sync the open state back.

  const playSwitchSound = useSound(switch005Sound);
  const expandedCount = [tasksOpen, mainOpen, chatOpen].filter(Boolean).length;

  const toggleTasks = () => {
    if (tasksOpen && expandedCount <= 1) return;
    playSwitchSound();
    if (tasksOpen) {
      tasksPanelRef.current?.collapse();
    } else {
      tasksPanelRef.current?.expand();
    }
  };
  const toggleMain = () => {
    if (mainOpen && expandedCount <= 1) return;
    playSwitchSound();
    if (mainOpen) {
      mainPanelRef.current?.collapse();
    } else {
      mainPanelRef.current?.expand();
    }
  };
  const toggleChat = () => {
    if (chatOpen && expandedCount <= 1) return;
    playSwitchSound();
    if (chatOpen) {
      chatPanelRef.current?.collapse();
    } else {
      chatPanelRef.current?.resize(Math.min(chatPanelWidth, 35));
    }
  };

  const { setOpenMobile, openMobile: mobileSidebarOpen } = useSidebar();
  const setMobileSidebarOpen = setOpenMobile;

  const onNewTask = useRef<(() => void) | null>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — subscribes to document keydown for ⇧⌘S new-task shortcut; DOM event listener has no React 19 alternative
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (isModKey(e) && e.shiftKey && e.code === "KeyS" && !e.repeat) {
        e.preventDefault();
        onNewTask.current?.();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const panelControls = {
    chatOpen,
    tasksOpen,
    mainOpen,
    chatPanelRef,
    tasksPanelRef,
    mainPanelRef,
    chatPanelWidth,
    onNewTask,
  };

  // Compute Chat.Provider virtualMcpId
  const chatVirtualMcpId =
    agentVirtualMcpId ?? getWellKnownDecopilotVirtualMCP(org.id).id;

  // On org home, provide the decopilot ID so VirtualMCPProvider is available
  const providerVirtualMcpId =
    agentVirtualMcpId ?? (isOrgHome ? chatVirtualMcpId : undefined);

  // --- Mobile layout: full-screen with hamburger toolbar ---
  if (isMobile) {
    const mobileSidebarSheet = (
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent
          side="left"
          hideCloseButton
          className="w-[calc(100vw-3rem)] sm:max-w-md! p-0"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {isSettingsRoute ? (
            <SettingsSidebarMobile
              onClose={() => setMobileSidebarOpen(false)}
            />
          ) : (
            <div className="flex h-full">
              {/* Icon sidebar rail — mirrors desktop collapsed sidebar */}
              <div
                className="w-14 shrink-0 bg-sidebar flex flex-col items-center border-r border-border overflow-y-auto group/sidebar"
                data-state="collapsed"
              >
                <MeshSidebarMobile
                  onClose={() => setMobileSidebarOpen(false)}
                />
              </div>
              {/* Tasks / agent panel */}
              <div className="flex-1 min-w-0 overflow-hidden">
                <TasksSidePanel
                  virtualMcpId={showThreePanels ? tasksVirtualMcpId : undefined}
                  hideProjectHeader={isOrgHome}
                  showAutomations={!isOrgHome}
                />
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    );

    if (showThreePanels) {
      return (
        <PanelContextProvider value={panelControls}>
          <div className="flex flex-col flex-1 bg-background min-h-0">
            <VirtualMCPScope virtualMcpId={providerVirtualMcpId}>
              <Chat.Provider
                key={chatVirtualMcpId}
                virtualMcpId={chatVirtualMcpId}
              >
                <NewTaskBridge onNewTaskRef={onNewTask} />
                <MobileToolbar
                  onOpenSidebar={() => setMobileSidebarOpen(true)}
                />
                <div className="flex-1 min-h-0 overflow-hidden">
                  {isOrgHome ? (
                    <ActiveTaskBoundary variant="home" />
                  ) : mainDefaultCollapsed ? (
                    <ActiveTaskBoundary />
                  ) : (
                    <Outlet />
                  )}
                </div>
                {mobileSidebarSheet}
              </Chat.Provider>
            </VirtualMCPScope>
          </div>
        </PanelContextProvider>
      );
    }

    return (
      <PanelContextProvider value={panelControls}>
        <div className="flex flex-col flex-1 bg-background min-h-0">
          <MobileToolbar onOpenSidebar={() => setMobileSidebarOpen(true)} />
          <div className="flex-1 overflow-hidden">
            <Outlet />
          </div>
          {mobileSidebarSheet}
        </div>
      </PanelContextProvider>
    );
  }

  // --- Desktop layout: resizable 3-panel ---
  return (
    <PanelContextProvider value={panelControls}>
      <SidebarLayout
        className="flex-1 bg-sidebar"
        style={
          {
            "--sidebar-width-icon": "3.5rem",
          } as Record<string, string>
        }
      >
        {isSettingsRoute ? <SettingsSidebar /> : <MeshSidebar />}
        <SidebarInset
          className="flex flex-col"
          style={{ background: "transparent", containerType: "inline-size" }}
        >
          <div className="shrink-0 flex items-center justify-between pl-1 pr-2 h-10">
            <div className="flex items-center gap-0.5 min-w-0">
              {showThreePanels && (
                <>
                  <button
                    type="button"
                    onClick={toggleTasks}
                    aria-pressed={tasksOpen}
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                      tasksOpen
                        ? "bg-sidebar-accent text-sidebar-foreground"
                        : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                    )}
                    title="Toggle tasks"
                  >
                    <LayoutLeft size={16} />
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          onNewTask.current?.();
                        }}
                        aria-label="New task"
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
                      >
                        <Edit05 size={16} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      className="flex items-center gap-1.5"
                    >
                      New task
                      <span className="flex items-center gap-0.5">
                        {(isMac ? ["⇧", "⌘", "S"] : ["⇧", "Ctrl", "S"]).map(
                          (key) => (
                            <kbd
                              key={key}
                              className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-sm border border-white/20 bg-white/10 text-white/70 text-xs font-mono"
                            >
                              {key}
                            </kbd>
                          ),
                        )}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
              <button
                type="button"
                onClick={() => window.history.back()}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
                title="Go back"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                type="button"
                onClick={() => window.history.forward()}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
                title="Go forward"
              >
                <ChevronRight size={16} />
              </button>
              <ToolbarBreadcrumb />
            </div>
            {showThreePanels && (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={toggleMain}
                  aria-pressed={mainOpen}
                  disabled={isOrgHome}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md transition-colors",
                    isOrgHome
                      ? "text-sidebar-foreground/30 cursor-not-allowed"
                      : mainOpen
                        ? "bg-sidebar-accent text-sidebar-foreground"
                        : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  )}
                  title="Toggle content"
                >
                  <Browser size={16} />
                </button>
                <button
                  type="button"
                  onClick={toggleChat}
                  aria-pressed={chatOpen}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md transition-colors",
                    chatOpen
                      ? "bg-sidebar-accent text-sidebar-foreground"
                      : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  )}
                  title="Toggle chat"
                >
                  <MessageTextCircle02 size={16} />
                </button>
              </div>
            )}
          </div>

          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center">
                <Loading01
                  size={20}
                  className="animate-spin text-muted-foreground"
                />
              </div>
            }
          >
            <VirtualMCPScope virtualMcpId={providerVirtualMcpId}>
              <Chat.Provider
                key={chatVirtualMcpId}
                virtualMcpId={chatVirtualMcpId}
              >
                <NewTaskBridge onNewTaskRef={onNewTask} />
                <AgentPanelGroup
                  agentVirtualMcpId={agentVirtualMcpId}
                  isAgentRoute={isAgentRoute}
                  isOrgHome={isOrgHome}
                  showThreePanels={showThreePanels}
                  tasksVirtualMcpId={tasksVirtualMcpId}
                  tasksPanelRef={tasksPanelRef}
                  mainPanelRef={mainPanelRef}
                  chatPanelRef={chatPanelRef}
                  chatDefaultCollapsed={chatDefaultCollapsed}
                  mainDefaultCollapsed={mainDefaultCollapsed}
                  setTasksOpen={setTasksOpen}
                  setMainOpen={setMainOpen}
                  setChatOpen={setChatOpen}
                />
              </Chat.Provider>
            </VirtualMCPScope>
          </Suspense>
        </SidebarInset>
      </SidebarLayout>
    </PanelContextProvider>
  );
}

function ShellLayoutContent() {
  const orgMatch = useMatch({ from: "/shell/$org", shouldThrow: false });
  const org = orgMatch?.params.org;
  const routerState = useRouterState();
  const agentsMatch = useMatch({
    from: "/shell/$org/$virtualMcpId",
    shouldThrow: false,
  });
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — subscribes to document keydown for ⌘K shortcuts dialog; DOM event listener has no React 19 alternative
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

  // Check if we're on an agent route (/$org/$virtualMcpId) but not settings
  const isAgentRoute =
    !!agentsMatch && !routerState.location.pathname.includes("/settings");

  // Check if we're on the org home route (/$org or /$org/)
  const isOrgHome =
    routerState.location.pathname === `/${org}` ||
    routerState.location.pathname === `/${org}/`;

  // Check if we're on settings routes (/$org/settings/*)
  const isSettingsRoute = routerState.location.pathname.startsWith(
    `/${org}/settings`,
  );

  const { data: activeOrg } = useSuspenseQuery({
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

      return data;
    },
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Check org-level SSO enforcement (must be before early returns to satisfy Rules of Hooks)
  const orgId = activeOrg?.id;
  const { data: ssoStatus } = useOrgSsoStatus(orgId);

  if (!activeOrg) {
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

  if (ssoStatus?.ssoRequired && !ssoStatus.authenticated) {
    return (
      <SsoRequiredScreen
        orgId={activeOrg.id}
        orgName={activeOrg.name}
        domain={ssoStatus.domain}
      />
    );
  }

  return (
    <ShellProjectProvider org={{ ...activeOrg, logo: activeOrg.logo ?? null }}>
      <PersistentSidebarProvider defaultOpen={isSettingsRoute}>
        <div className="flex flex-col h-dvh overflow-hidden">
          <ShellLayoutInner
            isAgentRoute={isAgentRoute}
            isOrgHome={isOrgHome}
            isSettingsRoute={isSettingsRoute}
          />
        </div>
      </PersistentSidebarProvider>

      {/* Keyboard Shortcuts Dialog */}
      <KeyboardShortcutsDialog
        open={shortcutsDialogOpen}
        onOpenChange={setShortcutsDialogOpen}
      />
    </ShellProjectProvider>
  );
}

export default function ShellLayout() {
  return (
    <RequiredAuthLayout>
      <ShellLayoutContent />
    </RequiredAuthLayout>
  );
}
