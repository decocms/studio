/**
 * Agent Shell Layout
 *
 * Desktop layout:
 *   SidebarInset
 *   ├── Toolbar                            (outside Suspense)
 *   │   • Toolbar.Nav (back/forward)
 *   │   • Toolbar.TabsSlot    (portal target — main-panel tab bar)
 *   │   • Toolbar.TogglesSlot (portal target — tasks/chat)
 *   └── flex-row
 *       ├── TasksPanelColumn               (owned by org-shell-layout)
 *       └── Suspense
 *           └── AgentInsetProvider
 *               • useVirtualMCP (suspends here)
 *               • Toolbar.Toggles → portal into slot
 *               • Toolbar.Tabs → portal into slot
 *               • Chat.Provider → ChatMainPanelGroup
 *
 * Mobile layout is unchanged (sheet-based tasks + chat).
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
import { TasksPanel } from "@/web/layouts/tasks-panel";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { isModKey } from "@/web/lib/keyboard-shortcuts";
import { StudioSidebarMobile } from "@/web/components/sidebar";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import { Sheet, SheetContent, SheetTitle } from "@deco/ui/components/sheet.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { AlertCircle, Loading01, Menu01 } from "@untitledui/icons";
import {
  getWellKnownDecopilotVirtualMCP,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useVmStart } from "@/web/components/vm/hooks/use-vm-start";
import { useStatusSounds } from "../../hooks/use-status-sounds";
import { authClient } from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import { EmptyState } from "@/web/components/empty-state";
import { useChatMainPanelState } from "@/web/hooks/use-layout-state";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { useOptionalTasksPanelState } from "@/web/hooks/use-tasks-panel-state";
import { Toolbar } from "./toolbar";
import { ChatMainPanelGroup } from "./chat-main-panel-group";
import { ToggleButtons } from "./toggle-buttons";
import { MainPanelTabsBar } from "@/web/layouts/main-panel-tabs/main-panel-tabs-bar";
import { VirtualMcpHeaderInfo } from "../../views/virtual-mcp/header-info.tsx";
import { VmEventsProvider } from "@/web/components/vm/hooks/vm-events-context.tsx";
import type { VmMapEntry } from "@decocms/mesh-sdk";
import { useEnsureTask } from "@/web/hooks/use-tasks";

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
          {children ?? <ChatCenterPanel />}
        </Chat.ActiveTaskProvider>
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
  vmMap,
  children,
}: {
  virtualMcpId: string;
  hasActiveGithubRepo: boolean;
  vmMap: Record<string, Record<string, VmMapEntry>> | undefined;
  children: ReactNode;
}) {
  const { org } = useProjectContext();
  const { currentBranch } = useChatTask();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  // Auto-start the VM when the active task points at a branch without a
  // registered vmMap entry. Routed through useVmStart so concurrent mounts
  // (preview, env, this bridge) for the same (virtualMcpId, branch) collapse
  // onto one in-flight upstream call.
  const autoStartClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { mutate: triggerAutoStart } = useVmStart(autoStartClient);
  // Attempt at most one auto-start per (branch, mount). A user VM_DELETE
  // removes the vmMap entry — without a permanent guard the effect would
  // re-fire and resurrect the VM the user just stopped.
  const autoStartAttemptedRef = useRef<Set<string>>(new Set());
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — fires VM_START when vmMap is missing an entry for (user, branch); ref guard dedupes within this mount, module-level map dedupes across components
  useEffect(() => {
    if (!hasActiveGithubRepo) return;
    if (!userId) return;
    if (!currentBranch) return;
    if (vmMap?.[userId]?.[currentBranch]) {
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
    vmMap,
    virtualMcpId,
    triggerAutoStart,
  ]);

  return (
    <VmEventsProvider
      virtualMcpId={virtualMcpId}
      branch={currentBranch ?? null}
    >
      {children}
    </VmEventsProvider>
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
  const tasksOpen = useOptionalTasksPanelState()?.tasksOpen ?? false;

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
              className="w-14 shrink-0 bg-sidebar flex flex-col items-center border-r border-border overflow-y-auto group/sidebar"
              data-state="collapsed"
            >
              <StudioSidebarMobile
                onClose={() => setMobileSidebarOpen(false)}
              />
            </div>
            <div className="flex-1 min-w-0 overflow-hidden">
              <TasksPanel />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    );

    return (
      <InsetContext value={insetContextValue}>
        <div className="flex flex-col flex-1 bg-background min-h-0">
          <Chat.Provider key={chatVirtualMcpId} virtualMcpId={chatVirtualMcpId}>
            <VmEventsBridge
              virtualMcpId={virtualMcpId}
              hasActiveGithubRepo={hasActiveGithubRepo}
              vmMap={entity?.metadata?.vmMap}
            >
              <NewTaskBridge
                onNewTaskRef={onNewTask}
                createNewTask={layout.createNewTask}
              />
              <MobileToolbar onOpenSidebar={() => setMobileSidebarOpen(true)} />
              <div className="flex-1 min-h-0 overflow-hidden">
                <ActiveTaskBoundary />
              </div>
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
            onNewTask={tasksOpen ? undefined : layout.createNewTask}
          />
        </Toolbar.Toggles>

        <Chat.Provider key={chatVirtualMcpId} virtualMcpId={chatVirtualMcpId}>
          <Toolbar.Tabs>
            <MainPanelTabsBar
              virtualMcpId={virtualMcpId}
              taskId={layout.taskId}
            />
          </Toolbar.Tabs>

          <VmEventsBridge
            virtualMcpId={virtualMcpId}
            hasActiveGithubRepo={hasActiveGithubRepo}
            vmMap={entity?.metadata?.vmMap}
          >
            <VirtualMcpHeaderInfo virtualMcp={entity} />
            <NewTaskBridge
              onNewTaskRef={onNewTask}
              createNewTask={layout.createNewTask}
            />
            <ChatMainPanelGroup
              virtualMcpId={virtualMcpId}
              taskId={layout.taskId}
              chatOpen={layout.chatOpen}
              mainOpen={layout.mainOpen}
              chatContent={<ActiveTaskBoundary />}
            />
          </VmEventsBridge>
        </Chat.Provider>
      </InsetContext>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default export — the per-task content for /$org/$taskId.
//
// Sidebar, toolbar shell, org-wide tasks panel, ChatPrefsProvider, and
// TasksPanelStateProvider all live in `org-shell-layout` (the parent route).
// This component just renders the per-task chrome inside the flex-row Outlet
// on desktop, or directly inside SidebarInset on mobile.
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
