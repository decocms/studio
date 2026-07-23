/**
 * Agent Shell Layout
 *
 * Desktop layout — each panel owns its own 48px header (no shared top bar):
 *   AgentInsetProvider
 *   • useVirtualMCP (suspends here)
 *   • Chat.Provider
 *     └── VmEventsBridge
 *         └── Chat.ActiveTaskProvider
 *             └── WorkspacePanelGroup
 *                 ├── Chat panel  (header: Chat toggle)
 *                 └── Main panel  (header: view tabs + toggles, Preview
 *                     controls, publish). Buttons relocate between the two
 *                     headers so nothing disappears when a panel is closed.
 *
 * Mobile layout (single shared header on top, owned by org-shell):
 *   Chat.Provider
 *   └── VmEventsBridge
 *       └── Chat.ActiveTaskProvider
 *           └── MainPanelWithDrawer OR ActiveTaskBoundary (sheet-based)
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
import { useChatPrefs } from "@/web/components/chat/context";
import { ChatSidePanel } from "@/web/components/chat/side-panel-chat";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { isModKey } from "@/web/lib/keyboard-shortcuts";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { AlertCircle, Loading01 } from "@untitledui/icons";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
  parseBranchMap,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity, SandboxMap } from "@decocms/mesh-sdk/types";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useIsSandboxStartPending } from "@/web/components/sandbox/hooks/use-sandbox-start";
import { useStatusSounds } from "../../hooks/use-status-sounds";
import { authClient } from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import { EmptyState } from "@/web/components/empty-state";
import { useWorkspaceLayoutState } from "@/web/hooks/use-layout-state";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { useT } from "@/web/i18n/use-t.ts";
import { Toolbar } from "./toolbar";
import { WorkspacePanelGroup } from "./workspace-panel-group";
import { MobileMainPanelTabSelect } from "@/web/layouts/main-panel-tabs/mobile-main-panel-tab-select";
import { MainPanelWithDrawer } from "@/web/layouts/main-panel-tabs/main-panel-with-drawer";
import { SandboxEventsProvider } from "@/web/components/sandbox/hooks/sandbox-events-context.tsx";
import {
  SandboxLifecycleProvider,
  selectVmEntry,
  deriveOthersThreadLabel,
  type BranchMapEntryLike,
} from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";
import { useEnsureTask } from "@/web/hooks/use-ensure-task";
import { ShellRouteLoading } from "@/web/layouts/shell-route-loading";
import { OrgFilePreviewMount } from "./org-file-preview";
import { OrgFileOpenProvider } from "@/web/components/chat/org-file-open-context";
import { BlocksPreviewWorkspaceProvider } from "@/web/components/sandbox/blocks/blocks-preview-workspace-context";
import { SidePanel } from "./side-panel";
import { useAgentSandboxSession } from "@/web/hooks/use-agent-sandbox-session";

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
  const t = useT();
  return (
    <ErrorBoundary
      fallback={
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {t("agentShellLayout.agentShellLayout.chatLoadingError")}
        </div>
      }
    >
      <Suspense fallback={<Chat.Skeleton />}>
        {children ?? <ChatSidePanel />}
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

// ---------------------------------------------------------------------------
// VmEventsBridge — thin branch resolver. Derives (branch, shouldConnect) and
// mounts SandboxEventsProvider + SandboxLifecycleProvider. Lives inside
// Chat.Provider so it can read useChatTask, which keeps the SSE connection
// and the lifecycle provider in sync with the active task as the user
// navigates between tasks (different tasks may pin different branches).
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
  const { currentBranch, activeTask } = useChatTask();
  const { org } = useProjectContext();
  const { pendingSandboxProviderKind } = useChatPrefs();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const { data: agentSandboxSession } = useAgentSandboxSession(
    org.slug,
    virtualMcpId,
    currentBranch,
  );

  // Overlay the thread's own sandbox record for the current branch. `load_repo`
  // binds a repo to the thread and persists its sandbox there (the ephemeral
  // Decopilot agent's sandboxMap never persists), so the preview must read the
  // thread's entry, not just the agent's.
  const threadSandboxMap = activeTask?.metadata?.sandboxMap as
    | SandboxMap
    | undefined;
  const threadEffectiveSandboxMap: SandboxMap | undefined =
    userId && currentBranch && threadSandboxMap?.[userId]?.[currentBranch]
      ? {
          ...(sandboxMap ?? {}),
          [userId]: {
            ...(sandboxMap?.[userId] ?? {}),
            [currentBranch]: threadSandboxMap[userId]![currentBranch]!,
          },
        }
      : sandboxMap;
  const effectiveSandboxMap: SandboxMap | undefined =
    userId &&
    currentBranch &&
    agentSandboxSession?.desiredState === "running" &&
    agentSandboxSession.status === "ready" &&
    agentSandboxSession.sandboxHandle
      ? {
          ...(threadEffectiveSandboxMap ?? {}),
          [userId]: {
            ...(threadEffectiveSandboxMap?.[userId] ?? {}),
            [currentBranch]: {
              ...parseBranchMap(
                threadEffectiveSandboxMap?.[userId]?.[currentBranch],
              ),
              "agent-sandbox": {
                sandboxHandle: agentSandboxSession.sandboxHandle,
                previewUrl: agentSandboxSession.previewUrl,
                sandboxApiUrl: agentSandboxSession.sandboxApiUrl,
                sandboxProviderKind: "agent-sandbox",
                startedWith: agentSandboxSession.startedWith ?? undefined,
              },
            },
          },
        }
      : threadEffectiveSandboxMap;
  const effectiveHasGithubRepo =
    hasActiveGithubRepo || agentHasClonableSource(activeTask?.metadata);

  // Someone else's thread: hold auto-start behind a confirmation gate so the
  // sandbox doesn't silently boot on the creator's branch (mirrors the chat
  // composer's read-only banner). Ownership rule lives in the pure, tested
  // deriveOthersThreadLabel; own thread → null (no gate).
  const othersThreadLabel = deriveOthersThreadLabel({
    userId: userId ?? null,
    createdBy: activeTask?.created_by,
    branch: activeTask?.branch,
    title: activeTask?.title,
  });

  // Open the events stream only when a sandbox actually exists or a start is
  // in flight — NOT merely because the agent has a GitHub repo configured.
  // Gate instead on a registered sandboxMap entry, or an in-flight
  // SANDBOX_START (covers the booting window; SandboxLifecycleProvider's
  // auto-start shares this mutation key, so `useIsSandboxStartPending`
  // observes it).
  const isStartPending = useIsSandboxStartPending(
    virtualMcpId,
    currentBranch ?? undefined,
  );
  const branchMap =
    userId && currentBranch
      ? (parseBranchMap(
          effectiveSandboxMap?.[userId]?.[currentBranch],
        ) as Record<string, BranchMapEntryLike>)
      : {};
  // Use the resolved provider kind to pick the matching entry — same logic as
  // SandboxLifecycleProvider so the SSE previewUrl and the lifecycle vmEntry
  // always agree on which sandbox is active.
  const vmEntry = pendingSandboxProviderKind
    ? ((branchMap[pendingSandboxProviderKind] as
        | BranchMapEntryLike
        | undefined) ?? null)
    : selectVmEntry(branchMap);
  const previewUrl = vmEntry?.previewUrl ?? null;
  const shouldConnect =
    Object.keys(branchMap).length > 0 ||
    isStartPending ||
    agentSandboxSession?.status === "provisioning" ||
    agentSandboxSession?.status === "reaping";

  return (
    <SandboxEventsProvider
      virtualMcpId={virtualMcpId}
      branch={currentBranch ?? null}
      previewUrl={previewUrl}
      enabled={shouldConnect}
    >
      <SandboxLifecycleProvider
        virtualMcpId={virtualMcpId}
        branch={currentBranch ?? null}
        userId={userId ?? null}
        hasActiveGithubRepo={effectiveHasGithubRepo}
        sandboxMap={effectiveSandboxMap}
        sandboxProviderKind={pendingSandboxProviderKind}
        sharedDesiredState={agentSandboxSession?.desiredState ?? null}
        sharedLifecyclePending={
          agentSandboxSession?.status === "provisioning" ||
          agentSandboxSession?.status === "reaping"
        }
        othersThreadLabel={othersThreadLabel}
        othersThreadId={activeTask?.id ?? null}
      >
        <BlocksPreviewWorkspaceProvider
          key={`${virtualMcpId}:${currentBranch ?? "no-branch"}`}
        >
          {children}
        </BlocksPreviewWorkspaceProvider>
      </SandboxLifecycleProvider>
    </SandboxEventsProvider>
  );
}

// ---------------------------------------------------------------------------
// Task workspace — the chat + main-panel region, rendered inside
// Chat.ActiveTaskProvider.
//
// The no-runtime state (no AI provider AND no usable local CLI) is handled
// per-surface, not by unmounting the workspace: the Chat side-panel view shows
// provider-setup empty state, the view tabs disable themselves
// (main-panel-tabs-bar), and the Overview view swaps to the setup prompt
// (overview-tab). Sandbox-backed views (Preview / Settings / Deck / …) stay
// available without a cloud provider.
// ---------------------------------------------------------------------------

type TaskLayout = ReturnType<typeof useWorkspaceLayoutState>;

function DesktopTaskWorkspace({
  entity,
  virtualMcpId,
  layout,
  onNewTaskRef,
}: {
  entity: VirtualMCPEntity;
  virtualMcpId: string;
  layout: TaskLayout;
  onNewTaskRef: React.MutableRefObject<(() => void) | null>;
}) {
  return (
    <>
      <NewTaskBridge
        onNewTaskRef={onNewTaskRef}
        createNewTask={layout.createNewTask}
      />
      {/* Panels each own a 48px header (tabs / toggles / publish). Everything
          lives under SandboxEventsProvider — useMainPanelTabs gates Content on
          lifecycle.phase === "running" + decofile. */}
      <Suspense fallback={<Chat.Skeleton />}>
        <WorkspacePanelGroup
          virtualMcpId={virtualMcpId}
          taskId={layout.taskId}
          entity={entity}
          sidePanel={layout.sidePanel}
          mainOpen={layout.mainOpen}
          toggleSidePanel={layout.toggleSidePanel}
          chatContent={<ActiveTaskBoundary />}
        />
      </Suspense>
    </>
  );
}

function MobileTaskWorkspace({
  virtualMcpId,
  layout,
  onNewTaskRef,
}: {
  virtualMcpId: string;
  layout: TaskLayout;
  onNewTaskRef: React.MutableRefObject<(() => void) | null>;
}) {
  const t = useT();
  const mobileSurface = layout.mainOpen ? "main" : (layout.sidePanel ?? "chat");

  return (
    <>
      {/* No Chat/Tasks/Library toggles on mobile: there's no side-by-side split,
          so one surface shows at a time and every destination (Chat, the main
          views, Tasks, Library) lives in this single dropdown instead. */}
      <Toolbar.Tabs>
        <MobileMainPanelTabSelect
          virtualMcpId={virtualMcpId}
          taskId={layout.taskId}
        />
      </Toolbar.Tabs>
      <NewTaskBridge
        onNewTaskRef={onNewTaskRef}
        createNewTask={layout.createNewTask}
      />
      <Suspense fallback={<Chat.Skeleton />}>
        <div className="flex-1 min-h-0 overflow-hidden">
          {mobileSurface === "main" ? (
            <ErrorBoundary
              fallback={
                <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                  {t("agentShellLayout.agentShellLayout.somethingWentWrong")}
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
                <div data-testid="main-panel" className="h-full">
                  <MainPanelWithDrawer
                    taskId={layout.taskId}
                    virtualMcpId={virtualMcpId}
                  />
                </div>
              </Suspense>
            </ErrorBoundary>
          ) : (
            <SidePanel chatContent={<ActiveTaskBoundary />} />
          )}
        </div>
      </Suspense>
    </>
  );
}

// ---------------------------------------------------------------------------
// AgentInsetProvider — resolves virtualMcpId, provides InsetContext,
// wraps in Chat.Provider, renders the task-scoped chat+main panel group.
// ---------------------------------------------------------------------------

function AgentInsetProvider() {
  const t = useT();
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

  const layoutMetadata = entity?.metadata?.ui?.layout ?? null;
  const entityMetadata = layoutMetadata
    ? {
        defaultMainView: layoutMetadata.defaultMainView ?? null,
        chatDefaultOpen: layoutMetadata.chatDefaultOpen ?? null,
      }
    : null;

  const hasActiveGithubRepo = !!(entity && getActiveGithubRepo(entity));
  const layout = useWorkspaceLayoutState(entityMetadata, {
    virtualMcpId,
    orgSlug,
    isAgentRoute: true,
  });

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
            {t("agentShellLayout.agentShellLayout.creatingTask")}
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
            <div className="font-medium">
              {t("agentShellLayout.agentShellLayout.taskUnavailable")}
            </div>
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
              title={t("agentShellLayout.agentShellLayout.agentNotFound")}
              description={t(
                "agentShellLayout.agentShellLayout.agentNotFoundDescription",
                { virtualMcpId },
              )}
              actions={
                <Button
                  variant="outline"
                  onClick={() =>
                    navigate({ to: "/$org", params: { org: orgSlug } })
                  }
                >
                  {t("agentShellLayout.agentShellLayout.goToOrgHome")}
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
              <Chat.ActiveTaskProvider
                key={layout.taskId}
                taskId={layout.taskId}
              >
                <Suspense fallback={<Chat.Skeleton />}>
                  <MobileTaskWorkspace
                    virtualMcpId={chatVirtualMcpId}
                    layout={layout}
                    onNewTaskRef={onNewTask}
                  />
                </Suspense>
              </Chat.ActiveTaskProvider>
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
            {/* The toggles, tabs, header, and main panel all render inside
                ActiveTaskProvider via DesktopTaskWorkspace. The runtime-setup
                prompt lives only in the chat side panel; the tabs stay
                navigable regardless. */}
            <Chat.ActiveTaskProvider key={layout.taskId} taskId={layout.taskId}>
              <Suspense fallback={<Chat.Skeleton />}>
                <DesktopTaskWorkspace
                  entity={entity}
                  virtualMcpId={virtualMcpId}
                  layout={layout}
                  onNewTaskRef={onNewTask}
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
    <Suspense fallback={<ShellRouteLoading />}>
      <OrgFileOpenProvider>
        <AgentInsetProvider />
        <OrgFilePreviewMount />
      </OrgFileOpenProvider>
    </Suspense>
  );
}
