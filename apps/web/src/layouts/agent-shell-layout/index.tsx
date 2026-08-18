/**
 * Agent Shell Layout
 *
 * Desktop layout — each panel owns its own 48px header (no shared top bar):
 *   AgentInsetProvider
 *   • useVirtualMCP (suspends here)
 *   • Chat.Provider
 *     └── VmEventsBridge
 *         └── ActiveTaskRuntimeProvider
 *             └── WorkspacePanelGroup
 *                 ├── Chat panel  (header: Chat toggle)
 *                 └── Main panel  (header: view tabs + toggles, Preview
 *                     controls, publish). Buttons relocate between the two
 *                     headers so nothing disappears when a panel is closed.
 *
 * Mobile layout (single shared header on top, owned by org-shell):
 *   Chat.Provider
 *   └── VmEventsBridge
 *       └── ActiveTaskRuntimeProvider
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
import { Chat, useChatTask } from "@/components/chat/index";
import { useChatPrefs } from "@/components/chat/context";
import { ChatSidePanel } from "@/components/chat/side-panel-chat";
import { ErrorBoundary } from "@/components/error-boundary";
import { isModKey } from "@/lib/keyboard-shortcuts";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { AlertCircle, Loading01 } from "@untitledui/icons";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
  parseBranchMap,
} from "@/sdk";
import type { VirtualMCPEntity, SandboxMap } from "@decocms/shared/sdk/types";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { generateBranchName } from "@decocms/shared/branch-name";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useIsSandboxStartPending } from "@/components/sandbox/hooks/use-sandbox-start";
import { useStatusSounds } from "../../hooks/use-status-sounds";
import { authClient } from "@/lib/auth-client";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@/components/empty-state";
import {
  resolveMobileSurface,
  useWorkspaceLayoutState,
} from "@/hooks/use-layout-state";
import { useRefreshViewedThreadMetadata } from "@/hooks/use-refresh-viewed-thread-metadata";
import { getActiveGithubRepo } from "@/lib/github-repo";
import { useT } from "@/i18n/use-t.ts";
import { Toolbar } from "./toolbar";
import { WorkspacePanelGroup } from "./workspace-panel-group";
import { MobileMainPanelTabSelect } from "@/layouts/main-panel-tabs/mobile-main-panel-tab-select";
import { MainPanelWithDrawer } from "@/layouts/main-panel-tabs/main-panel-with-drawer";
import { SandboxEventsProvider } from "@/components/sandbox/hooks/sandbox-events-context.tsx";
import {
  SandboxLifecycleProvider,
  resolveVmEntry,
  overlayThreadSandboxMap,
  shouldAdoptBranch,
  type BranchMapEntryLike,
} from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { useEnsureTask } from "@/hooks/use-ensure-task";
import { ShellRouteLoading } from "@/layouts/shell-route-loading";
import { OrgFilePreviewMount } from "./org-file-preview";
import { OrgFileOpenProvider } from "@/components/chat/org-file-open-context";
import { BlocksPreviewWorkspaceProvider } from "@/components/sandbox/blocks/blocks-preview-workspace-context";
import { resolveCmsMode } from "@/sdk/cms-mode";
import { SidePanel } from "./side-panel";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import { useAgentRuntimeAdapter } from "@/lib/desktop/agent-runtime-slot";
import { shouldBlockHostedRuntime } from "@/components/chat/hosted-runtime-guard";

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
  const isDesktopApp = useIsDesktopApp();
  const runtimeAdapter = useAgentRuntimeAdapter();
  const defaultContent = isDesktopApp ? (
    runtimeAdapter ? (
      <runtimeAdapter.SidePanel />
    ) : null
  ) : (
    <ChatSidePanel />
  );
  return (
    <ErrorBoundary
      fallback={
        <div
          role="alert"
          className="flex-1 flex items-center justify-center text-sm text-muted-foreground"
        >
          {t("agentShellLayout.agentShellLayout.chatLoadingError")}
        </div>
      }
    >
      <Suspense fallback={<Chat.Skeleton />}>
        {children ?? defaultContent}
      </Suspense>
    </ErrorBoundary>
  );
}

function ActiveTaskRuntimeProvider({
  taskId,
  children,
}: {
  taskId: string;
  children: ReactNode;
}) {
  const t = useT();
  const isDesktopApp = useIsDesktopApp();
  const runtimeAdapter = useAgentRuntimeAdapter();

  if (isDesktopApp) {
    if (!runtimeAdapter) {
      return (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center p-8 text-sm text-destructive"
        >
          {t("agentShellLayout.agentShellLayout.nativeRuntimeUnavailable")}
        </div>
      );
    }
    return (
      <runtimeAdapter.ActiveTaskProvider taskId={taskId}>
        {children}
      </runtimeAdapter.ActiveTaskProvider>
    );
  }

  return (
    <Chat.ActiveTaskProvider taskId={taskId}>
      {children}
    </Chat.ActiveTaskProvider>
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
  const t = useT();
  const { currentBranch, activeTask, setCurrentTaskBranch } = useChatTask();
  const { pendingSandboxProviderKind } = useChatPrefs();
  const isDesktopApp = useIsDesktopApp();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const executionEnabled = !shouldBlockHostedRuntime({
    isDesktopApp,
    harnessId: activeTask?.harness_id,
    sandboxProviderKind: activeTask?.sandbox_provider_kind,
  });

  // Overlay the thread's own sandbox record for the current branch. A thread has
  // ONE sandbox, recorded under its creator and resolved server-side for every
  // member who opens the thread — see overlayThreadSandboxMap.
  const effectiveSandboxMap = overlayThreadSandboxMap({
    agentSandboxMap: sandboxMap,
    threadSandboxMap: activeTask?.metadata?.sandboxMap as
      | SandboxMap
      | undefined,
    userId,
    ownerId: activeTask?.created_by,
    branch: currentBranch,
  });
  const effectiveHasGithubRepo =
    hasActiveGithubRepo || agentHasClonableSource(activeTask?.metadata);

  // Assign a branch to a loaded repo-backed thread that has none, so the
  // branch-gated auto-start can run for it. Only reachable when the repo was
  // attached to the agent after the thread was created (COLLECTION_THREADS_CREATE
  // assigns one otherwise). See shouldAdoptBranch.
  //
  // Ceiling: two tabs on the same such thread each mint once, and the row keeps
  // the last write — the loser's sandbox is orphaned. Bounded to one mint per
  // thread per tab; a shared lock is the fix if that ever shows up in practice.
  const adoptedBranchForThreadRef = useRef<string | null>(null);
  const adoptBranchEligible =
    executionEnabled &&
    shouldAdoptBranch({
      threadLoaded: !!activeTask,
      isOwner: !!userId && activeTask?.created_by === userId,
      hasActiveGithubRepo: effectiveHasGithubRepo,
      branch: currentBranch ?? null,
      // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read-only dedup probe; recorded inside the effect after firing
      attempted: adoptedBranchForThreadRef.current === (activeTask?.id ?? null),
    });
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- one-shot row write gated on the resolved thread; no render-time equivalent
  useEffect(() => {
    if (!adoptBranchEligible || !activeTask) return;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- record the thread so a re-render can't mint twice
    adoptedBranchForThreadRef.current = activeTask.id;
    setCurrentTaskBranch(
      generateBranchName(
        // TODO: swap for `branchUserLabel` once decocms/studio#5513 lands — `??`
        // would let Better Auth's empty display name through and slug to "user".
        session?.user?.name || session?.user?.email?.split("@")[0],
      ),
    );
  }, [adoptBranchEligible, activeTask, session, setCurrentTaskBranch]);

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
  // Use the resolved provider kind to pick the matching entry — the SAME
  // helper as SandboxLifecycleProvider so the SSE previewUrl and the lifecycle
  // vmEntry always agree on which sandbox is active.
  const vmEntry = resolveVmEntry(branchMap, pendingSandboxProviderKind);
  const previewUrl = vmEntry?.previewUrl ?? null;
  const shouldConnect =
    executionEnabled && (Object.keys(branchMap).length > 0 || isStartPending);

  // Native coding-agent threads are intentionally unavailable on hosted web.
  // Do not mount their workspace at all: every main-panel surface assumes it
  // may mutate a sandbox (Git publish/rebase, filesystem writes, process
  // control, setup, suggestion generation). A disabled composer or lifecycle
  // provider cannot make those independent consumers read-only.
  if (!executionEnabled) {
    return (
      <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
        <div className="flex h-full rounded-[0.75rem] bg-background card-shadow">
          <EmptyState
            image={<AlertCircle size={48} className="text-muted-foreground" />}
            title={t(
              "agentShellLayout.agentShellLayout.runtimeUnavailableOnWeb",
            )}
            description={t(
              "agentShellLayout.agentShellLayout.runtimeUnavailableOnWebDescription",
            )}
          />
        </div>
      </div>
    );
  }

  return (
    <SandboxEventsProvider
      virtualMcpId={virtualMcpId}
      branch={currentBranch ?? null}
      previewUrl={previewUrl}
      enabled={shouldConnect}
    >
      <SandboxLifecycleProvider
        executionEnabled={executionEnabled}
        virtualMcpId={virtualMcpId}
        branch={currentBranch ?? null}
        userId={userId ?? null}
        hasActiveGithubRepo={effectiveHasGithubRepo}
        sandboxMap={effectiveSandboxMap}
        sandboxProviderKind={pendingSandboxProviderKind}
        threadId={activeTask?.id ?? null}
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
// the selected active-task runtime provider.
//
// The hosted no-runtime state (no AI provider) is handled by the structured
// chat side panel, not by unmounting the workspace. Native coding agents use
// the terminal runtime adapter and never enter this provider-setup path.
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
          toggleMain={layout.toggleMain}
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
  const mobileSurface = resolveMobileSurface({
    visibility: { sidePanel: layout.sidePanel, mainOpen: layout.mainOpen },
    sidePanelParamPresent: layout.sidePanelParamPresent,
  });

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
                <div
                  role="alert"
                  className="flex-1 flex items-center justify-center text-sm text-muted-foreground"
                >
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

  // Read-only teammate threads: pull the current metadata (githubRepo /
  // sandboxMap bound by load_repo after the panel snapshot) so the preview
  // doesn't render "no source" / miss the owner's sandbox. No-op for own
  // threads. Must run before the early returns (Rules of Hooks).
  useRefreshViewedThreadMetadata(
    ensureState.status === "ready" ? ensureState.task : null,
  );

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
    defaultSidePanelKind: resolveCmsMode(entity?.metadata).active
      ? "cms"
      : "chat",
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
          <div
            role="status"
            aria-live="polite"
            className="flex h-full items-center justify-center bg-background card-shadow rounded-[0.75rem] text-sm text-muted-foreground"
          >
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
          <div
            role="alert"
            className="flex flex-col h-full items-center justify-center gap-2 bg-background card-shadow rounded-[0.75rem] p-8 text-sm"
          >
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
              <ActiveTaskRuntimeProvider
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
              </ActiveTaskRuntimeProvider>
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
            {/* The toggles, tabs, header, and main panel all render inside the
                selected active-task runtime via DesktopTaskWorkspace. The
                runtime-setup prompt lives only in the side panel; the tabs
                stay navigable regardless. */}
            <ActiveTaskRuntimeProvider
              key={layout.taskId}
              taskId={layout.taskId}
            >
              <Suspense fallback={<Chat.Skeleton />}>
                <DesktopTaskWorkspace
                  entity={entity}
                  virtualMcpId={virtualMcpId}
                  layout={layout}
                  onNewTaskRef={onNewTask}
                />
              </Suspense>
            </ActiveTaskRuntimeProvider>
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
