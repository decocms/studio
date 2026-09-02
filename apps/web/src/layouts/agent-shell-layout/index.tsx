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
  useState,
  useSyncExternalStore,
  use,
  Suspense,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Chat, useChatTask } from "@/components/chat/index";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import {
  decofileStatusQueryOptions,
  isBranchStale,
} from "@/components/sections-editor/decofile-api";
import { ChatSidePanel } from "@/components/chat/side-panel-chat";
import { ErrorBoundary } from "@/components/error-boundary";
import { isModKey } from "@/lib/keyboard-shortcuts";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { AlertCircle, Loading01 } from "@untitledui/icons";
import { useProjectContext, useVirtualMCP, parseBranchMap } from "@/sdk";
import type { VirtualMCPEntity, SandboxMap } from "@decocms/shared/sdk/types";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { generateBranchName } from "@decocms/shared/branch-name";
import { defaultThreadRuntime } from "@decocms/shared/thread/session-runtime";
import { useThreadManager } from "@/components/chat/store/hooks";
import { findAgentEntryThread } from "@/lib/reusable-new-chat";
import { Navigate, useNavigate, useParams } from "@tanstack/react-router";
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
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import {
  SandboxLifecycleProvider,
  overlayThreadSandboxMap,
  shouldAdoptBranch,
} from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { useEnsureTask } from "@/hooks/use-ensure-task";
import { ShellRouteLoading } from "@/layouts/shell-route-loading";
import { LegacyMainRedirect } from "@/layouts/legacy-main-redirect";
import { LegacyThreadRedirect } from "@/layouts/legacy-thread-redirect";
import { useRouteThreadId, useRouteVirtualMcpId } from "@/layouts/thread-route";
import { OrgFilePreviewMount } from "./org-file-preview";
import { OrgFileOpenProvider } from "@/components/chat/org-file-open-context";
import { BlocksPreviewWorkspaceProvider } from "@/components/sandbox/blocks/blocks-preview-workspace-context";
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
  /**
   * The native terminal panel renders a session, and there is no session until
   * a thread exists. Until then both runtimes show the structured composer,
   * whose first send mints the thread the terminal then attaches to.
   */
  const hasThread = useRouteThreadId() !== null;
  const defaultContent =
    isDesktopApp && hasThread ? (
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
  threadId,
  children,
}: {
  threadId: string | null;
  children: ReactNode;
}) {
  const t = useT();
  const isDesktopApp = useIsDesktopApp();
  const runtimeAdapter = useAgentRuntimeAdapter();

  /**
   * No thread means no runtime to own: nothing to stream, nothing to attach a
   * terminal to. The threadless provider installs the same stream shape the
   * panel consumes and mints the thread on the first send.
   */
  if (threadId === null) {
    return <Chat.ThreadlessProvider>{children}</Chat.ThreadlessProvider>;
  }

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
      <runtimeAdapter.ActiveTaskProvider taskId={threadId}>
        {children}
      </runtimeAdapter.ActiveTaskProvider>
    );
  }

  return (
    <Chat.ActiveTaskProvider taskId={threadId}>
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
  const isDesktopApp = useIsDesktopApp();
  const expectedSandboxProviderKind = isDesktopApp
    ? "local-api"
    : "agent-sandbox";
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const executionEnabled = !shouldBlockHostedRuntime({
    isDesktopApp,
    harnessId: activeTask?.harness_id,
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

  /**
   * Auto-fresh-branch (org-gated, off by default): opening the CMS on a branch
   * whose last commit predates the staleness window moves the session to a
   * freshly minted branch off the default branch. The stale branch is left on
   * GitHub. One switch per thread per tab, mirroring the adopt guard above.
   */
  const { org } = useProjectContext();
  const autoFreshBranchEnabled = useOrgFlag("cms_auto_fresh_branch");
  const sessionState = useSessionRuntime(virtualMcpId);
  const freshBranchForThreadRef = useRef<string | null>(null);
  const staleCheckEnabled =
    autoFreshBranchEnabled &&
    sessionState.resolved &&
    sessionState.runtime === "cms" &&
    !!org?.slug &&
    !!currentBranch &&
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read-only dedup probe; recorded inside the effect after firing
    freshBranchForThreadRef.current !== (activeTask?.id ?? null);
  const staleStatusQuery = useQuery({
    ...decofileStatusQueryOptions({
      orgSlug: org?.slug ?? "",
      virtualMcpId,
      branch: currentBranch ?? "",
    }),
    enabled: staleCheckEnabled,
  });
  const staleLastCommitAt = staleStatusQuery.data?.lastCommitAt ?? null;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- one-shot branch switch gated on the resolved CMS status; no render-time equivalent
  useEffect(() => {
    if (!staleCheckEnabled || !activeTask) return;
    if (!isBranchStale(staleLastCommitAt, Date.now())) return;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- record the thread so a re-render can't switch twice
    freshBranchForThreadRef.current = activeTask.id;
    setCurrentTaskBranch(
      generateBranchName(
        session?.user?.name || session?.user?.email?.split("@")[0],
      ),
    );
  }, [
    staleCheckEnabled,
    staleLastCommitAt,
    activeTask,
    session,
    setCurrentTaskBranch,
  ]);

  // Open the events stream only when a sandbox actually exists or a start is
  // in flight — NOT merely because the agent has a GitHub repo configured.
  // Gate instead on a registered sandboxMap entry, or an in-flight
  // SANDBOX_START (covers the booting window; SandboxLifecycleProvider's
  // auto-start shares this mutation key, so `useIsSandboxStartPending`
  // observes it).
  /** `null` until the answer is real — never act on the project default. */
  const sessionRuntime = sessionState.resolved ? sessionState.runtime : null;
  const isStartPending = useIsSandboxStartPending(
    virtualMcpId,
    currentBranch ?? undefined,
  );
  const branchMap =
    userId && currentBranch
      ? parseBranchMap(effectiveSandboxMap?.[userId]?.[currentBranch])
      : {};
  const vmEntry = branchMap[expectedSandboxProviderKind] ?? null;
  const previewUrl = vmEntry?.previewUrl ?? null;
  // A CMS session has no daemon to stream from, whatever the map holds. The
  // presence/pending term stays: it answers a different question (is there a
  // sandbox to stream FROM), and dropping it opens a 90s no-claim stream and
  // reconnect loop for every idle coding-session thread.
  const shouldConnect =
    executionEnabled &&
    sessionRuntime !== "cms" &&
    (!!vmEntry || isStartPending);

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

  /**
   * A CMS session does not get the sandbox machinery AT ALL — not a stopped
   * one, not an idle one. The providers below are keyed by (vMCP, branch), and
   * a coding session SHARES the CMS draft's branch by design, so a sibling
   * session's boot failure rendered its "Couldn't start the sandbox" card
   * inside the CMS chat — which owns no sandbox and never asked for one.
   *
   * Gating each leaf (auto-start, the events stream, the preview surface) is
   * whack-a-mole: every new consumer has to remember. Not mounting the
   * providers makes the whole class unrepresentable — `useSandboxLifecycle`
   * and `useSandboxEvents` fall through to their inert defaults, so there is
   * no lifecycle to fail, no claim to retry, and no card to render.
   */
  if (sessionRuntime === "cms") {
    return (
      <BlocksPreviewWorkspaceProvider
        key={`${virtualMcpId}:${currentBranch ?? "no-branch"}:${activeTask?.id ?? ""}`}
      >
        {children}
      </BlocksPreviewWorkspaceProvider>
    );
  }

  return (
    <SandboxEventsProvider
      // Keyed by the THREAD, not the branch: a coding session shares the CMS
      // draft's branch, so two sessions differ only by thread id. Without it
      // React keeps one provider instance across the switch and the previous
      // session's boot error stays on screen in the next one.
      key={activeTask?.id ?? "no-thread"}
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
        vmEntry={vmEntry}
        threadId={activeTask?.id ?? null}
      >
        <BlocksPreviewWorkspaceProvider
          key={`${virtualMcpId}:${currentBranch ?? "no-branch"}:${activeTask?.id ?? ""}`}
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
          taskId={layout.threadId}
          entity={entity}
          sidePanelOpen={layout.sidePanelOpen}
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
    visibility: {
      sidePanelOpen: layout.sidePanelOpen,
      mainOpen: layout.mainOpen,
    },
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
          taskId={layout.threadId}
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
                    taskId={layout.threadId}
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

  const params = useParams({ strict: false });
  const orgSlug = params.org ?? "";

  const routeThreadId = useRouteThreadId();
  /** The agent is the `{-$project}` segment on a destination, `?virtualmcpid=` on the legacy route. */
  const virtualMcpId = useRouteVirtualMcpId();
  /** A stable thread id to mint when a repo-backed editor arrives with none and
   *  the user has no idle empty chat to reuse, so a re-render before the URL
   *  catches up reuses it instead of looping through fresh ones. Generated once
   *  per mount; only used by the redirect below. */
  const [generatedThreadId] = useState(() => crypto.randomUUID());
  const { data: session } = authClient.useSession();
  const threadManager = useThreadManager();
  const threads = useSyncExternalStore(
    threadManager.threads.subscribe,
    threadManager.threads.get,
  );

  // Ensure the thread row exists for this URL before rendering the chat. On
  // 404 the hook fires COLLECTION_THREADS_CREATE (idempotent) and surfaces a
  // "Creating task…" state until the row is persisted. Without this the
  // chat renders with branch=null because the thread never existed.
  const ensureState = useEnsureTask(routeThreadId, virtualMcpId);

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

  /**
   * A repo-backed editor's branch is a thread field, so it must run on a thread;
   * mint one into `?thread=` before mounting when the URL names none (#6667). The
   * Super Agent (no repo) keeps its lazy threadless composer.
   */
  if (routeThreadId === null && hasActiveGithubRepo) {
    // Resume the last branch for this repo-backed agent, else its empty chat, else mint one.
    const threadId =
      findAgentEntryThread(
        threads,
        virtualMcpId,
        session?.user?.id,
        defaultThreadRuntime(entity.metadata),
        hasActiveGithubRepo,
      )?.id ?? generatedThreadId;
    return (
      <Navigate
        to="."
        replace
        search={(prev: Record<string, unknown>) => ({
          ...prev,
          thread: threadId,
        })}
      />
    );
  }

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
                key={layout.providerKey}
                threadId={layout.threadId}
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
              key={layout.providerKey}
              threadId={layout.threadId}
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
      {/* Rewrites a legacy `/$org/$taskId` URL into the first-class shape,
          without unmounting anything below it. */}
      <LegacyThreadRedirect />
      <LegacyMainRedirect />
      <OrgFileOpenProvider>
        <AgentInsetProvider />
        <OrgFilePreviewMount />
      </OrgFileOpenProvider>
    </Suspense>
  );
}
