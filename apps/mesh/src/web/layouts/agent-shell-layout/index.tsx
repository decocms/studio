/**
 * Agent Shell Layout
 *
 * Desktop layout:
 *   SidebarInset
 *   ├── Toolbar                            (outside Suspense)
 *   │   • Toolbar.Nav (back/forward)
 *   │   • Toolbar.TabsSlot    (portal target — main-panel tab bar)
 *   │   • Toolbar.TogglesSlot (portal target — chat / new-task)
 *   └── Suspense
 *       └── AgentInsetProvider
 *           • useVirtualMCP (suspends here)
 *           • Toolbar.Toggles → portal into slot
 *           • Toolbar.Tabs → portal into slot
 *           • Chat.Provider
 *             └── VmEventsBridge
 *                 └── Chat.ActiveTaskProvider
 *                     └── ChatMainPanelGroup
 *                         (the per-thread todo list is rendered
 *                          by TodosHighlight inside ChatHighlight,
 *                          not as a side column)
 *
 * Mobile layout:
 *   Chat.Provider
 *   └── Chat.ActiveTaskProvider
 *       └── MainPanelContent OR ActiveTaskBoundary (sheet-based)
 */

import {
  createContext,
  useEffect,
  useLayoutEffect,
  useRef,
  use,
  Suspense,
  type ReactNode,
} from "react";
import { Chat, useChatTask } from "@/web/components/chat/index";
import { ChatCenterPanel } from "@/web/layouts/chat-center-panel";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { isModKey } from "@/web/lib/keyboard-shortcuts";
import { StudioSidebarMobile } from "@/web/components/sidebar";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import { Sheet, SheetContent, SheetTitle } from "@deco/ui/components/sheet.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import {
  AlertCircle,
  Edit05,
  Loading01,
  Menu01,
  MessageCircle01,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.js";
import {
  getWellKnownDecopilotVirtualMCP,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
  parseBranchMap,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity, SandboxMap } from "@decocms/mesh-sdk/types";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  useSandboxStart,
  useIsSandboxStartPending,
} from "@/web/components/sandbox/hooks/use-sandbox-start";
import { useStatusSounds } from "../../hooks/use-status-sounds";
import { authClient } from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import { EmptyState } from "@/web/components/empty-state";
import { useChatMainPanelState } from "@/web/hooks/use-layout-state";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { Toolbar } from "./toolbar";
import { ChatMainPanelGroup } from "./chat-main-panel-group";
import { ToggleButtons } from "./toggle-buttons";
import { MainPanelContent } from "@/web/layouts/main-panel-tabs";
import { MainPanelTabsBar } from "@/web/layouts/main-panel-tabs/main-panel-tabs-bar";
import { VirtualMcpHeaderInfo } from "../../views/virtual-mcp/header-info.tsx";
import { SandboxEventsProvider } from "@/web/components/sandbox/hooks/sandbox-events-context.tsx";
import { SandboxLifecycleProvider } from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";
import { useEnsureTask } from "@/web/hooks/use-ensure-task";

// ---------------------------------------------------------------------------
// Types & Context
// ---------------------------------------------------------------------------

export interface InsetContextValue {
  virtualMcpId: string;
  entity: VirtualMCPEntity | null;
}

const InsetContext = createContext<InsetContextValue | null>(null);

export function useInsetContext(): InsetContextValue | null {
  return use(InsetContext);
}

// ---------------------------------------------------------------------------
// Agent inset sub-components
// ---------------------------------------------------------------------------

function ActiveTaskBoundary({ children }: { children?: React.ReactNode }) {
  return (
    <ErrorBoundary
      fallback={
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Something went wrong loading the chat. Try refreshing.
        </div>
      }
    >
      <Suspense fallback={<Chat.Skeleton />}>
        {children ?? <ChatCenterPanel />}
      </Suspense>
    </ErrorBoundary>
  );
}

function NewTaskBridge({
  onNewTaskRef,
  createNewTask,
}: {
  onNewTaskRef: React.MutableRefObject<(() => void) | null>;
  createNewTask: () => void;
}) {
  useLayoutEffect(() => {
    onNewTaskRef.current = createNewTask;
    return () => {
      onNewTaskRef.current = null;
    };
  });
  return null;
}

function MobileToolbar({
  onOpenSidebar,
  virtualMcpId,
  taskId,
  mainOpen,
  onToggleMain,
  onNewTask,
  entity,
  hasActiveGithubRepo,
}: {
  onOpenSidebar: () => void;
  virtualMcpId: string;
  taskId: string;
  mainOpen: boolean;
  onToggleMain: () => void;
  onNewTask: () => void;
  entity: VirtualMCPEntity | null;
  hasActiveGithubRepo: boolean;
}) {
  return (
    <div className="shrink-0 flex items-center gap-1 px-2 h-12 bg-background border-b border-border">
      <button
        type="button"
        onClick={onOpenSidebar}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/60 hover:bg-accent hover:text-foreground transition-colors"
        aria-label="Open menu"
      >
        <Menu01 size={20} />
      </button>
      <div className="flex-1 min-w-0 overflow-x-auto [scrollbar-width:none]">
        <MainPanelTabsBar virtualMcpId={virtualMcpId} taskId={taskId} />
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {entity && hasActiveGithubRepo ? (
          <VirtualMcpHeaderInfo virtualMcp={entity} inline />
        ) : null}
        <button
          type="button"
          onClick={onToggleMain}
          aria-pressed={!mainOpen}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
            !mainOpen
              ? "bg-accent text-foreground"
              : "text-foreground/60 hover:bg-accent hover:text-foreground",
          )}
          title="Chat"
        >
          <MessageCircle01 size={16} />
        </button>
        <button
          type="button"
          onClick={onNewTask}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/60 hover:bg-accent hover:text-foreground transition-colors"
          title="New task"
        >
          <Edit05 size={16} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VmEventsBridge — passes (virtualMcpId, branch) to the unified VM events
// SSE provider and runs auto-start. Lives inside Chat.Provider so it can
// read useChatTask, which keeps the SSE connection in sync with the active
// task as the user navigates between tasks (different tasks may pin
// different branches).
// ---------------------------------------------------------------------------

function VmEventsBridge({
  virtualMcpId,
  hasActiveGithubRepo,
  sandboxMap,
  children,
}: {
  virtualMcpId: string;
  hasActiveGithubRepo: boolean;
  sandboxMap: SandboxMap | undefined;
  children: ReactNode;
}) {
  const { org } = useProjectContext();
  const { currentBranch } = useChatTask();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  // Auto-start the VM when the active task points at a branch without any
  // registered sandboxMap entry (regardless of kind). Routed through useSandboxStart so
  // concurrent mounts (preview, env, this bridge) for the same
  // (virtualMcpId, branch) collapse onto one in-flight upstream call.
  // The server's resolveDefaultSandboxProviderKind decides the kind when
  // sandboxProviderKind is omitted — this is intentional for implicit auto-start.
  const autoStartClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { mutate: triggerAutoStart } = useSandboxStart(autoStartClient);
  // Attempt at most one auto-start per (branch, mount). A user SANDBOX_DELETE
  // removes the sandboxMap entry — without a permanent guard the effect would
  // re-fire and resurrect the sandbox the user just stopped.
  const autoStartAttemptedRef = useRef<Set<string>>(new Set());
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — fires SANDBOX_START when sandboxMap is missing an entry for (user, branch); ref guard dedupes within this mount, module-level map dedupes across components
  useEffect(() => {
    if (!hasActiveGithubRepo) return;
    if (!userId) return;
    if (!currentBranch) return;
    // Use parseBranchMap to handle both legacy 2-level and current 3-level shapes.
    // If any entry exists for this (user, branch) — regardless of kind — a VM is
    // already running; don't auto-start.
    const branchMap = parseBranchMap(sandboxMap?.[userId]?.[currentBranch]);
    if (Object.keys(branchMap).length > 0) {
      // VM is already running — record the branch so a user stop won't
      // re-trigger auto-start within this mount.
      autoStartAttemptedRef.current.add(currentBranch);
      return;
    }
    if (autoStartAttemptedRef.current.has(currentBranch)) return;
    autoStartAttemptedRef.current.add(currentBranch);
    triggerAutoStart(
      { virtualMcpId, branch: currentBranch },
      {
        onError: (err) => {
          console.error("[auto-start-vm] failed:", err);
        },
      },
    );
  }, [
    hasActiveGithubRepo,
    userId,
    currentBranch,
    sandboxMap,
    virtualMcpId,
    triggerAutoStart,
  ]);

  // Open the events stream only when a sandbox actually exists or a start is
  // in flight — NOT merely because the agent has a GitHub repo configured.
  // Gate instead on a registered sandboxMap entry, or an in-flight
  // SANDBOX_START (covers the booting window; the auto-start above shares this
  // mutation key, so `useIsSandboxStartPending` observes it).
  const isStartPending = useIsSandboxStartPending(
    virtualMcpId,
    currentBranch ?? undefined,
  );
  const branchMap =
    userId && currentBranch
      ? parseBranchMap(sandboxMap?.[userId]?.[currentBranch])
      : {};
  const shouldConnect = Object.keys(branchMap).length > 0 || isStartPending;

  return (
    <SandboxEventsProvider
      virtualMcpId={virtualMcpId}
      branch={currentBranch ?? null}
      enabled={shouldConnect}
    >
      <SandboxLifecycleProvider
        virtualMcpId={virtualMcpId}
        branch={currentBranch ?? null}
        userId={userId ?? null}
        hasActiveGithubRepo={hasActiveGithubRepo}
        sandboxMap={sandboxMap}
        orgId={org.id}
      >
        {children}
      </SandboxLifecycleProvider>
    </SandboxEventsProvider>
  );
}

// ---------------------------------------------------------------------------
// AgentInsetProvider — resolves virtualMcpId, provides InsetContext,
// wraps in Chat.Provider, renders the task-scoped chat+main panel group.
// ---------------------------------------------------------------------------

function AgentInsetProvider() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { org } = useProjectContext();

  useStatusSounds(org.slug);

  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
    pluginId?: string;
  };
  const orgSlug = params.org ?? "";

  const search = useSearch({ strict: false }) as {
    virtualmcpid?: string;
  };
  const virtualMcpId =
    search.virtualmcpid ?? getWellKnownDecopilotVirtualMCP(org.id).id;

  // Ensure the thread row exists for this URL before rendering the chat. On
  // 404 the hook fires COLLECTION_THREADS_CREATE (idempotent) and surfaces a
  // "Creating task…" state until the row is persisted. Without this the
  // chat renders with branch=null because the thread never existed.
  const ensureState = useEnsureTask(params.taskId ?? "", virtualMcpId);

  // Fetch entity (Suspense-based — resolved before render)
  const entity = useVirtualMCP(virtualMcpId);

  const layoutMetadata = (entity?.metadata as any)?.ui?.layout ?? null;
  const entityMetadata = layoutMetadata
    ? {
        defaultMainView: layoutMetadata.defaultMainView ?? null,
        chatDefaultOpen: layoutMetadata.chatDefaultOpen ?? null,
      }
    : null;

  const hasActiveGithubRepo = !!(entity && getActiveGithubRepo(entity));

  const layout = useChatMainPanelState(entityMetadata, {
    virtualMcpId,
    orgSlug,
    isAgentRoute: true,
  });

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

  const chatVirtualMcpId = virtualMcpId;

  const insetContextValue: InsetContextValue = {
    virtualMcpId,
    entity,
  };

  if (ensureState.status === "creating" || ensureState.status === "loading") {
    return (
      <InsetContext value={insetContextValue}>
        <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
          <div className="flex h-full items-center justify-center bg-background card-shadow rounded-[0.75rem] text-sm text-muted-foreground">
            <Loading01 className="size-4 animate-spin mr-2" />
            Creating task…
          </div>
        </div>
      </InsetContext>
    );
  }

  if (ensureState.status === "error") {
    return (
      <InsetContext value={insetContextValue}>
        <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
          <div className="flex flex-col h-full items-center justify-center gap-2 bg-background card-shadow rounded-[0.75rem] p-8 text-sm">
            <div className="font-medium">Task unavailable</div>
            <div className="text-muted-foreground">
              {ensureState.error.message}
            </div>
          </div>
        </div>
      </InsetContext>
    );
  }

  if (!entity) {
    return (
      <InsetContext value={insetContextValue}>
        <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
          <div className="flex flex-col h-full bg-background overflow-hidden card-shadow rounded-[0.75rem]">
            <EmptyState
              image={
                <AlertCircle size={48} className="text-muted-foreground" />
              }
              title="Agent not found"
              description={`The agent "${virtualMcpId}" does not exist in this organization.`}
              actions={
                <Button
                  variant="outline"
                  onClick={() =>
                    navigate({ to: "/$org", params: { org: orgSlug } })
                  }
                >
                  Go to organization home
                </Button>
              }
            />
          </div>
        </div>
      </InsetContext>
    );
  }

  // Mobile layout — unchanged semantics, just inlined here for clarity.
  if (isMobile) {
    const mobileSidebarSheet = (
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
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
              <StudioSidebarMobile
                onClose={() => setMobileSidebarOpen(false)}
              />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    );

    return (
      <InsetContext value={insetContextValue}>
        <div className="flex flex-col flex-1 min-w-0 bg-background min-h-0">
          <Chat.Provider
            key={chatVirtualMcpId}
            virtualMcpId={chatVirtualMcpId}
            task={ensureState.status === "ready" ? ensureState.task : null}
          >
            <VmEventsBridge
              virtualMcpId={virtualMcpId}
              hasActiveGithubRepo={hasActiveGithubRepo}
              sandboxMap={entity?.metadata?.sandboxMap}
            >
              <NewTaskBridge
                onNewTaskRef={onNewTask}
                createNewTask={layout.createNewTask}
              />
              <Chat.ActiveTaskProvider
                key={layout.taskId}
                taskId={layout.taskId}
              >
                <MobileToolbar
                  onOpenSidebar={() => setMobileSidebarOpen(true)}
                  virtualMcpId={chatVirtualMcpId}
                  taskId={layout.taskId}
                  mainOpen={layout.mainOpen}
                  onToggleMain={layout.toggleMain}
                  onNewTask={layout.createNewTask}
                  entity={entity}
                  hasActiveGithubRepo={hasActiveGithubRepo}
                />
                <Suspense fallback={<Chat.Skeleton />}>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {layout.mainOpen ? (
                      <ErrorBoundary
                        fallback={
                          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                            Something went wrong. Try refreshing.
                          </div>
                        }
                      >
                        <Suspense
                          fallback={
                            <div className="h-full flex items-center justify-center">
                              <Loading01
                                size={20}
                                className="animate-spin text-muted-foreground"
                              />
                            </div>
                          }
                        >
                          <MainPanelContent
                            taskId={layout.taskId}
                            virtualMcpId={chatVirtualMcpId}
                          />
                        </Suspense>
                      </ErrorBoundary>
                    ) : (
                      <ActiveTaskBoundary />
                    )}
                  </div>
                </Suspense>
              </Chat.ActiveTaskProvider>
              {mobileSidebarSheet}
            </VmEventsBridge>
          </Chat.Provider>
        </div>
      </InsetContext>
    );
  }

  // Desktop — portal toggle buttons into outer toolbar, render chat+main group.
  // The org-wide tasks column is owned by org-shell-layout, outside this
  // Suspense boundary, so it stays mounted while this task-scoped content loads.
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <InsetContext value={insetContextValue}>
        <Toolbar.Toggles>
          <ToggleButtons
            chatOpen={layout.chatOpen}
            toggleChat={layout.toggleChat}
            onNewTask={layout.createNewTask}
          />
        </Toolbar.Toggles>

        <Chat.Provider
          key={chatVirtualMcpId}
          virtualMcpId={chatVirtualMcpId}
          task={ensureState.status === "ready" ? ensureState.task : null}
        >
          <VmEventsBridge
            virtualMcpId={virtualMcpId}
            hasActiveGithubRepo={hasActiveGithubRepo}
            sandboxMap={entity?.metadata?.sandboxMap}
          >
            {/* Tabs must live under SandboxEventsProvider — useMainPanelTabs
                gates Content on lifecycle.phase === "running" + decofile. */}
            <Toolbar.Tabs>
              <MainPanelTabsBar
                virtualMcpId={virtualMcpId}
                taskId={layout.taskId}
              />
            </Toolbar.Tabs>
            <NewTaskBridge
              onNewTaskRef={onNewTask}
              createNewTask={layout.createNewTask}
            />
            <Chat.ActiveTaskProvider key={layout.taskId} taskId={layout.taskId}>
              <VirtualMcpHeaderInfo virtualMcp={entity} />
              <Suspense fallback={<Chat.Skeleton />}>
                <ChatMainPanelGroup
                  virtualMcpId={virtualMcpId}
                  taskId={layout.taskId}
                  chatOpen={layout.chatOpen}
                  mainOpen={layout.mainOpen}
                  chatContent={<ActiveTaskBoundary />}
                />
              </Suspense>
            </Chat.ActiveTaskProvider>
          </VmEventsBridge>
        </Chat.Provider>
      </InsetContext>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default export — the per-task content for /$org/$taskId.
//
// Sidebar, toolbar shell, and ChatPrefsProvider live in `org-shell-layout`
// (the parent route). This component just renders the per-task chrome inside
// the flex-row Outlet on desktop, or directly inside SidebarInset on mobile.
// ---------------------------------------------------------------------------

export default function AgentShellLayout() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center">
          <Loading01 size={20} className="animate-spin text-muted-foreground" />
        </div>
      }
    >
      <AgentInsetProvider />
    </Suspense>
  );
}
