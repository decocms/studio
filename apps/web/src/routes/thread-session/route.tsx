import type { ReactNode } from "react";
/** Binds project and thread runtime to ChatLayout and its routed content. */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Chat, useChatTask } from "@/components/chat/index";
import { ChatSidePanel } from "@/components/chat/side-panel-chat";
import { ChatVoiceProvider } from "@/components/chat/voice";
import { ErrorBoundary } from "@/components/error-boundary";
import { isModKey } from "@/lib/keyboard-shortcuts";
import { AlertCircle } from "@untitledui/icons";
import { useProjectContext, useVirtualMCP, parseBranchMap } from "@/sdk";
import type { SandboxMap } from "@decocms/shared/sdk/types";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { generateBranchName } from "@decocms/shared/branch-name";
import {
  useThreadActions,
  useThreadManager,
} from "@/components/chat/store/hooks";
import {
  Navigate,
  Outlet,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useIsSandboxStartPending } from "@/components/sandbox/hooks/use-sandbox-start";
import { authClient } from "@/lib/auth-client";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@/components/empty-state";
import { useChatLayoutState } from "@/hooks/use-chat-layout-state";
import { useRefreshViewedThreadMetadata } from "@/hooks/use-refresh-viewed-thread-metadata";
import { getActiveRepository } from "@/lib/repository-binding";
import { useBaseBranch } from "@/components/thread/repository/use-version-gate";
import {
  nextDraftName,
  nextReleaseColor,
  useReleases,
} from "@/components/thread/repository/use-releases";
import { useT } from "@/i18n/use-t.ts";
import { Panel } from "@/components/panel";

import {
  ChatLayout,
  OpenMainPanelButton,
  useOptionalChatLayout,
} from "@/components/chat-layout";
import { SidebarToggleButton } from "@/layouts/route-page-header";
import { ThreadsMenu } from "@/components/chat/threads-menu";
import { NewChatCrumb } from "@/components/header/shell-breadcrumb";
import { MainPanelTabsBar } from "@/layouts/main-panel-tabs/main-panel-tabs-bar";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { resolveThreadSessionIdentity } from "./session-identity";
import { MobileMainPanelTabSelect } from "@/layouts/main-panel-tabs/mobile-main-panel-tab-select";
import { SandboxEventsProvider } from "@/components/sandbox/hooks/sandbox-events-context.tsx";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useAppTakeover } from "@/hooks/use-app-takeover";
import {
  SandboxLifecycleProvider,
  overlayThreadSandboxMap,
  shouldAdoptBranch,
} from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { useEnsureTask } from "@/hooks/use-ensure-task";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { LegacyAgentWorkspaceRedirect } from "@/layouts/legacy-agent-workspace-redirect";
import { getWellKnownDecopilotVirtualMCP } from "@/sdk";
import { LegacyMainRedirect } from "@/layouts/legacy-main-redirect";
import { LegacyThreadRedirect } from "@/layouts/legacy-thread-redirect";
import {
  useRouteThreadId,
  useRouteVirtualMcpId,
  useThreadNavigate,
} from "@/layouts/thread-route";
import { OrgFilePreviewMount } from "./org-file-preview";
import { OrgFileOpenProvider } from "@/components/chat/org-file-open-context";
import { BlocksPreviewWorkspaceProvider } from "@/components/sandbox/blocks/blocks-preview-workspace-context";
import { shouldBlockHostedRuntime } from "@/components/chat/hosted-runtime-guard";

// ---------------------------------------------------------------------------
// Thread runtime and presentation
// ---------------------------------------------------------------------------

function ActiveTaskBoundary({ children }: { children?: React.ReactNode }) {
  const t = useT();
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
      <MainPanelBoundary>{children ?? <ChatSidePanel />}</MainPanelBoundary>
    </ErrorBoundary>
  );
}

function ActiveTaskRuntimeProvider({
  threadId,
  providerKey,
  children,
}: {
  threadId: string | null;
  providerKey: string;
  children: ReactNode;
}) {
  /**
   * No thread means no runtime to own: nothing to stream. The threadless
   * source installs the same stream shape the panel consumes and mints the
   * thread on the first send. Only the source is keyed: a thread switch (or
   * that first send) must not remount the open app or close its chat.
   */
  return (
    <Chat.StreamHost
      source={
        threadId === null ? (
          <Chat.ThreadlessStreamSource key={providerKey} />
        ) : (
          <Chat.ActiveTaskStreamSource key={providerKey} taskId={threadId} />
        )
      }
    >
      {children}
    </Chat.StreamHost>
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
  hasActiveRepository,
  sandboxMap,
  children,
}: {
  virtualMcpId: string;
  hasActiveRepository: boolean;
  sandboxMap: SandboxMap | undefined;
  children: ReactNode;
}) {
  const t = useT();
  const { currentBranch, activeTask, setCurrentTaskBranch } = useChatTask();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const executionEnabled = !shouldBlockHostedRuntime(activeTask?.harness_id);

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
  const effectiveHasRepository =
    hasActiveRepository || agentHasClonableSource(activeTask?.metadata);

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
      hasActiveRepository: effectiveHasRepository,
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

  const sessionState = useSessionRuntime(virtualMcpId);

  // Auto-name a fresh draft as "Rascunho N"; one write per branch per tab, like the guards above.
  const draftsVm = useVirtualMCP(virtualMcpId);
  const draftsBase = useBaseBranch(draftsVm, currentBranch);
  const { releases: draftReleases, createRelease: createDraftRelease } =
    useReleases(virtualMcpId);
  const isOwnDraftThread = !!userId && activeTask?.created_by === userId;
  const currentIsUnnamedDraft =
    isOwnDraftThread &&
    !!currentBranch &&
    currentBranch !== draftsBase &&
    !draftReleases.some((r) => r.branch === currentBranch);
  const namedDraftForBranchRef = useRef<string | null>(null);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- one-shot release write for a fresh unnamed draft; no render-time equivalent
  useEffect(() => {
    if (!currentIsUnnamedDraft || !currentBranch) return;
    if (namedDraftForBranchRef.current === currentBranch) return;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- record the branch so a re-render can't create twice
    namedDraftForBranchRef.current = currentBranch;
    createDraftRelease({
      branch: currentBranch,
      name: nextDraftName(
        draftReleases,
        t("thread.branchPicker.defaultVersionName"),
      ),
      color: nextReleaseColor(draftReleases.length),
      createdBy: userId,
      createdAt: new Date().toISOString(),
    }).catch(() => {});
  }, [
    currentIsUnnamedDraft,
    currentBranch,
    draftReleases,
    createDraftRelease,
    userId,
    t,
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
  const vmEntry = branchMap["agent-sandbox"] ?? null;
  const previewUrl = vmEntry?.previewUrl ?? null;
  // A CMS session has no daemon to stream from, whatever the map holds. The
  // presence/pending term stays: it answers a different question (is there a
  // sandbox to stream FROM), and dropping it opens a 90s no-claim stream and
  // reconnect loop for every idle coding-session thread.
  const shouldConnect =
    executionEnabled &&
    sessionRuntime !== "cms" &&
    (!!vmEntry || isStartPending);

  // Coding-agent threads the hosted dispatcher cannot run are unavailable here.
  // Do not mount their workspace at all: every main-panel surface assumes it
  // may mutate a sandbox (Git publish/rebase, filesystem writes, process
  // control, setup, suggestion generation). A disabled composer or lifecycle
  // provider cannot make those independent consumers read-only.
  if (!executionEnabled) {
    return (
      <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
        <div className="flex h-full rounded-[0.75rem] bg-background shadow-edge">
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
        resetKey={`${virtualMcpId}:${currentBranch ?? "no-branch"}:${activeTask?.id ?? ""}`}
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
      // session's boot error stays on screen in the next one. A reset key,
      // not a `key`: remounting would also reload the open app.
      resetKey={activeTask?.id ?? "no-thread"}
      virtualMcpId={virtualMcpId}
      branch={currentBranch ?? null}
      previewUrl={previewUrl}
      enabled={shouldConnect}
    >
      <SandboxLifecycleProvider
        resetKey={activeTask?.id ?? "no-thread"}
        executionEnabled={executionEnabled}
        virtualMcpId={virtualMcpId}
        branch={currentBranch ?? null}
        userId={userId ?? null}
        hasActiveRepository={effectiveHasRepository}
        vmEntry={vmEntry}
        threadId={activeTask?.id ?? null}
      >
        <BlocksPreviewWorkspaceProvider
          resetKey={`${virtualMcpId}:${currentBranch ?? "no-branch"}:${activeTask?.id ?? ""}`}
        >
          {children}
        </BlocksPreviewWorkspaceProvider>
      </SandboxLifecycleProvider>
    </SandboxEventsProvider>
  );
}

// ---------------------------------------------------------------------------
// Thread presentation stays under the selected runtime; layout state contains no
// project entity or thread identity.
// ---------------------------------------------------------------------------

function ThreadTopbar() {
  const { virtualMcpId, taskId } = useChatTask();
  const mainPanelClosed = useOptionalChatLayout()?.contentOpen === false;
  return (
    <Panel.Topbar className="border-b border-border/60 pr-3 pl-1">
      <Panel.Topbar.Left>
        {/* With the main panel closed, the chat is the leftmost panel. */}
        <SidebarToggleButton showOnDesktop={mainPanelClosed} />
        <OpenMainPanelButton />
        <ThreadsMenu />
      </Panel.Topbar.Left>
      <div className="min-w-0 md:hidden">
        <MobileMainPanelTabSelect virtualMcpId={virtualMcpId} taskId={taskId} />
      </div>
      <Panel.Topbar.Right className="shrink-0">
        <NewChatCrumb />
      </Panel.Topbar.Right>
    </Panel.Topbar>
  );
}

function ThreadSessionContent({
  layout,
  onNewTaskRef,
  createNewTask,
}: {
  layout: ReturnType<typeof useChatLayoutState>;
  onNewTaskRef: React.MutableRefObject<(() => void) | null>;
  createNewTask: () => void;
}) {
  const { virtualMcpId, taskId } = useChatTask();

  const contentKey = useActivePanelTabId() ?? "overview";
  /** Takeover apps open full screen, in local state so neither `?sidepanel`
   *  nor the person's full-screen preference changes it. Keyed on the view,
   *  so showing the chat in one app does not carry into the next one. */
  const takeover = useAppTakeover();
  const [threadOpenIn, setThreadOpenIn] = useState<string | null>(null);
  const takeoverThreadOpen = threadOpenIn === contentKey;
  const threadOpen = takeover ? takeoverThreadOpen : layout.threadOpen;
  const toggleFullscreen = takeover
    ? () => setThreadOpenIn(takeoverThreadOpen ? null : contentKey)
    : layout.toggleFullscreen;

  return (
    <>
      <NewTaskBridge
        onNewTaskRef={onNewTaskRef}
        createNewTask={createNewTask}
      />
      <ChatLayout
        {...layout}
        threadOpen={threadOpen}
        toggleFullscreen={toggleFullscreen}
        contentKey={contentKey}
        contentNavigation={
          <MainPanelTabsBar virtualMcpId={virtualMcpId} taskId={taskId} />
        }
      >
        <Outlet />
        <ChatLayout.Thread topbar={<ThreadTopbar />}>
          {/* The conversation is per thread; the app beside it is not. */}
          <ActiveTaskBoundary key={taskId ?? "threadless"} />
        </ChatLayout.Thread>
      </ChatLayout>
    </>
  );
}

// ---------------------------------------------------------------------------
// Resolves route identity and initializes the existing thread/runtime providers.
// ---------------------------------------------------------------------------

function ThreadSessionProvider() {
  const t = useT();
  const navigate = useNavigate();
  const navigateThread = useThreadNavigate();
  const { create } = useThreadActions();
  const { org } = useProjectContext();

  const params = useParams({ strict: false });
  const orgSlug = params.org ?? "";

  const routeThreadId = useRouteThreadId();
  /** The page's project: it sets the layout and is context for the chat, never the chat's owner. */
  const virtualMcpId = useRouteVirtualMcpId();
  /** One chat follows the person across pages and projects, run by the org's assistant. */
  const superAgentId = getWellKnownDecopilotVirtualMCP(org.id).id;
  /** A stable id for the composer's next chat; generated once per mount. */
  const [generatedThreadId] = useState(() => crypto.randomUUID());
  const { data: session } = authClient.useSession();
  const threadManager = useThreadManager();
  const threads = useSyncExternalStore(
    threadManager.threads.subscribe,
    threadManager.threads.get,
  );
  const threadsStatus = useSyncExternalStore(
    threadManager.threadsStatus.subscribe,
    threadManager.threadsStatus.get,
  );

  const entity = useVirtualMCP(virtualMcpId);

  /** Set once an arrival lands on the empty composer, so a chat minted from it
   *  doesn't send the person back to their previous one. */
  const [composerSettled, setComposerSettled] = useState(false);
  if (routeThreadId !== null && composerSettled) {
    setComposerSettled(false);
  }

  // Ensure the thread row exists for this URL before rendering the chat.
  const ensureState = useEnsureTask(routeThreadId, superAgentId);

  // Read-only teammate threads: pull the current metadata before the early returns.
  useRefreshViewedThreadMetadata(
    ensureState.status === "ready" ? ensureState.task : null,
  );

  /** The chat keeps the agent it started with; older project chats still open as that project. */
  const chatAgentId =
    (ensureState.status === "ready"
      ? ensureState.task?.virtual_mcp_id
      : undefined) ?? superAgentId;
  const chatEntity = useVirtualMCP(chatAgentId);

  const layoutMetadata = entity?.metadata?.ui?.layout ?? null;
  const entityMetadata = layoutMetadata
    ? {
        defaultMainView: layoutMetadata.defaultMainView ?? null,
        chatDefaultOpen: layoutMetadata.chatDefaultOpen ?? null,
      }
    : null;

  const layout = useChatLayoutState(entityMetadata);
  const { threadId, providerKey } = resolveThreadSessionIdentity({
    routeThreadId,
    fallbackKey: generatedThreadId,
  });

  const createNewTask = async () => {
    const newTaskId = crypto.randomUUID();
    try {
      await create({ id: newTaskId, virtual_mcp_id: superAgentId });
    } catch {
      // The collection action reports errors; the route retries a missing row.
    }
    navigateThread(newTaskId, () => ({}));
  };

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

  // Every page resumes the person's latest chat; a new chat has its own id.
  if (
    routeThreadId === null &&
    !composerSettled &&
    threadsStatus.kind !== "loading"
  ) {
    const latest = threads
      .filter(
        (thread) =>
          !thread.hidden &&
          thread.virtual_mcp_id === superAgentId &&
          thread.created_by === session?.user?.id,
      )
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
      .at(0);
    if (latest) {
      return (
        <Navigate
          to="."
          replace
          search={(prev: Record<string, unknown>) => ({
            ...prev,
            thread: latest.id,
          })}
        />
      );
    }
    setComposerSettled(true);
  }

  if (ensureState.status === "creating" || ensureState.status === "loading") {
    return (
      <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
        <div
          role="status"
          aria-live="polite"
          className="flex h-full items-center justify-center bg-background shadow-edge rounded-[0.75rem] text-sm text-muted-foreground"
        >
          <Spinner className="size-4 mr-2" />
          {t("agentShellLayout.agentShellLayout.creatingTask")}
        </div>
      </div>
    );
  }

  if (ensureState.status === "error") {
    return (
      <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
        <div
          role="alert"
          className="flex flex-col h-full items-center justify-center gap-2 bg-background shadow-edge rounded-[0.75rem] p-8 text-sm"
        >
          <div className="font-medium">
            {t("agentShellLayout.agentShellLayout.taskUnavailable")}
          </div>
          <div className="text-muted-foreground">
            {ensureState.error.message}
          </div>
        </div>
      </div>
    );
  }

  if (!entity) {
    return (
      <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
        <div className="flex flex-col h-full bg-background overflow-hidden shadow-edge rounded-[0.75rem]">
          <EmptyState
            image={<AlertCircle size={48} className="text-muted-foreground" />}
            title={t("agentShellLayout.agentShellLayout.agentNotFound")}
            description={t(
              "agentShellLayout.agentShellLayout.agentNotFoundDescription",
              {
                virtualMcpId,
              },
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
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Chat.Provider
        key={chatAgentId}
        virtualMcpId={chatAgentId}
        task={ensureState.status === "ready" ? ensureState.task : null}
      >
        <ChatVoiceProvider layout={layout}>
          <VmEventsBridge
            virtualMcpId={chatAgentId}
            hasActiveRepository={
              !!(chatEntity && getActiveRepository(chatEntity))
            }
            sandboxMap={chatEntity?.metadata?.sandboxMap}
          >
            <ActiveTaskRuntimeProvider
              threadId={threadId}
              providerKey={providerKey}
            >
              <MainPanelBoundary>
                <ThreadSessionContent
                  layout={layout}
                  onNewTaskRef={onNewTask}
                  createNewTask={createNewTask}
                />
              </MainPanelBoundary>
            </ActiveTaskRuntimeProvider>
          </VmEventsBridge>
        </ChatVoiceProvider>
      </Chat.Provider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The parent organization route owns Layout. ThreadRoute owns the thread store
// and preferences; this route owns the selected project's session providers.
// ---------------------------------------------------------------------------

export default function ThreadSessionRoute() {
  const params = useParams({ strict: false });
  if (params.taskId !== undefined) return <LegacyThreadRedirect />;
  if (params._splat !== undefined) return <Outlet />;
  return (
    <MainPanelBoundary>
      <LegacyAgentWorkspaceRedirect>
        <LegacyMainRedirect>
          <OrgFileOpenProvider>
            <ThreadSessionProvider />
            <OrgFilePreviewMount />
          </OrgFileOpenProvider>
        </LegacyMainRedirect>
      </LegacyAgentWorkspaceRedirect>
    </MainPanelBoundary>
  );
}
