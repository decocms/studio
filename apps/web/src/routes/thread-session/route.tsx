import { LayoutLeft } from "@untitledui/icons";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
/** Binds project and thread runtime to ChatLayout and its routed content. */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Chat, useChatTask } from "@/components/chat/index";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import {
  decofileStatusQueryOptions,
  isBranchStale,
} from "@/components/sections-editor/decofile-api";
import { ChatSidePanel } from "@/components/chat/side-panel-chat";
import { ErrorBoundary } from "@/components/error-boundary";
import { isModKey } from "@/lib/keyboard-shortcuts";
import { AlertCircle } from "@untitledui/icons";
import { useProjectContext, useVirtualMCP, parseBranchMap } from "@/sdk";
import type { SandboxMap } from "@decocms/shared/sdk/types";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { generateBranchName } from "@decocms/shared/branch-name";
import { defaultThreadRuntime } from "@decocms/shared/thread/session-runtime";
import {
  useThreadActions,
  useThreadManager,
} from "@/components/chat/store/hooks";
import { findAgentEntryThread } from "@/lib/reusable-new-chat";
import {
  Navigate,
  Outlet,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useIsSandboxStartPending } from "@/components/sandbox/hooks/use-sandbox-start";
import { authClient } from "@/lib/auth-client";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@/components/empty-state";
import { useChatLayoutState } from "@/hooks/use-chat-layout-state";
import { useRefreshViewedThreadMetadata } from "@/hooks/use-refresh-viewed-thread-metadata";
import { getActiveGithubRepo } from "@/lib/github-repo";
import { useBaseBranch } from "@/components/thread/github/use-version-gate";
import {
  nextDraftName,
  nextReleaseColor,
  useReleases,
} from "@/components/thread/github/use-releases";
import { useT } from "@/i18n/use-t.ts";
import { Panel } from "@/components/panel";
import { useCompactPageLayout } from "@/hooks/use-preferences";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { PanelCollapseToggle } from "@/components/chat-layout/toggle-buttons";
import { ChatLayout, useChatLayout } from "@/components/chat-layout";
import { ThreadsMenu } from "@/components/chat/threads-menu";
import { NewChatCrumb } from "@/components/header/shell-breadcrumb";
import { DevAgentControl } from "@/components/dev-agent/dev-agent-control";
import { MainPanelTabsBar } from "@/layouts/main-panel-tabs/main-panel-tabs-bar";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { resolveThreadSessionIdentity } from "./session-identity";
import { MobileMainPanelTabSelect } from "@/layouts/main-panel-tabs/mobile-main-panel-tab-select";
import { SandboxEventsProvider } from "@/components/sandbox/hooks/sandbox-events-context.tsx";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import {
  SandboxLifecycleProvider,
  overlayThreadSandboxMap,
  shouldAdoptBranch,
} from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { useEnsureTask } from "@/hooks/use-ensure-task";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { LegacyAgentWorkspaceRedirect } from "@/layouts/legacy-agent-workspace-redirect";
import { canonicalThreadRouteTarget } from "@/layouts/main-panel-tabs/tab-route";
import { getWellKnownDecopilotVirtualMCP } from "@/sdk";
import {
  LegacyCanonicalNavigate,
  LegacyMainRedirect,
} from "@/layouts/legacy-main-redirect";
import { LegacyThreadRedirect } from "@/layouts/legacy-thread-redirect";
import {
  routeThreadMatchesAgent,
  useRouteAgentId,
  useRouteThreadId,
  useRouteVirtualMcpId,
  useThreadNavigate,
} from "@/layouts/thread-route";
import { OrgFilePreviewMount } from "./org-file-preview";
import { OrgFileOpenProvider } from "@/components/chat/org-file-open-context";
import { BlocksPreviewWorkspaceProvider } from "@/components/sandbox/blocks/blocks-preview-workspace-context";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import { useAgentRuntimeAdapter } from "@/lib/desktop/agent-runtime-slot";
import { shouldBlockHostedRuntime } from "@/components/chat/hosted-runtime-guard";

// ---------------------------------------------------------------------------
// Thread runtime and presentation
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
      <MainPanelBoundary>{children ?? defaultContent}</MainPanelBoundary>
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
      createdAt: new Date().toISOString(),
    }).catch(() => {});
  }, [
    currentIsUnnamedDraft,
    currentBranch,
    draftReleases,
    createDraftRelease,
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
// Thread presentation stays under the selected runtime; layout state contains no
// project entity or thread identity.
// ---------------------------------------------------------------------------

function ThreadTopbar() {
  const compact = useCompactPageLayout();
  const layout = useChatLayout();
  const t = useT();
  const { toggleSidebar } = useSidebar();
  const { virtualMcpId, taskId } = useChatTask();
  return (
    <Panel.Topbar className="compact:border-b compact:border-border/60 compact:px-3">
      <Panel.Topbar.Left>
        <ToolbarIconButton
          className="classic:hidden md:hidden"
          onClick={toggleSidebar}
          aria-label={t("layouts.shellControls.toggleSidebar")}
        >
          <LayoutLeft size={16} />
        </ToolbarIconButton>
        <ThreadsMenu />
      </Panel.Topbar.Left>
      <div className="classic:hidden min-w-0 md:hidden">
        <MobileMainPanelTabSelect virtualMcpId={virtualMcpId} taskId={taskId} />
      </div>
      <Panel.Topbar.Right className="shrink-0">
        <NewChatCrumb />
        {!compact && !layout.contentOpen && (
          <PanelCollapseToggle
            side="right"
            open={layout.contentOpen}
            onToggle={layout.toggleContent}
          />
        )}
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
  const compact = useCompactPageLayout();
  const isMobile = useIsMobile();
  const entity = useVirtualMCP(virtualMcpId);
  const contentKey = useActivePanelTabId() ?? "overview";

  return (
    <>
      {!compact && isMobile && (
        <Panel.Topbar.Center.Portal>
          <MobileMainPanelTabSelect
            virtualMcpId={virtualMcpId}
            taskId={taskId}
          />
        </Panel.Topbar.Center.Portal>
      )}
      <NewTaskBridge
        onNewTaskRef={onNewTaskRef}
        createNewTask={createNewTask}
      />
      <ChatLayout
        {...layout}
        contentKey={contentKey}
        contentNavigation={
          <MainPanelTabsBar virtualMcpId={virtualMcpId} taskId={taskId} />
        }
        contentActions={entity && <DevAgentControl virtualMcp={entity} />}
      >
        <ChatLayout.Thread topbar={<ThreadTopbar />}>
          <ActiveTaskBoundary />
        </ChatLayout.Thread>
        <Outlet />
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
  const sessionSearch = useSearch({ strict: false });

  const routeThreadId = useRouteThreadId();
  /** The canonical project path owns agent identity; organization routes use the Super Agent. */
  const virtualMcpId = useRouteVirtualMcpId();
  /** Truthy only when the route names a SCOPED agent; `undefined` at org level
   *  (where `virtualMcpId` falls back to the Super Agent). Gates the threadless
   *  entry-thread resolver so the org home keeps its fresh composer. */
  const routeAgentId = useRouteAgentId();
  /** A stable thread id to mint when a repo-backed editor arrives with none and
   *  the user has no idle empty chat to reuse, so a re-render before the URL
   *  catches up reuses it instead of looping through fresh ones. Generated once
   *  per mount; only used by the redirect below. */
  const [generatedThreadId] = useState(() => crypto.randomUUID());
  const { data: session } = authClient.useSession();
  /** Drafts-mode entry lands a fresh thread on an editable draft, never on
   *  read-only production. Generated once per mount, like the thread id above. */
  const [generatedDraftBranch] = useState(() =>
    generateBranchName(
      session?.user?.name || session?.user?.email?.split("@")[0],
    ),
  );
  const threadManager = useThreadManager();
  const threads = useSyncExternalStore(
    threadManager.threads.subscribe,
    threadManager.threads.get,
  );
  const threadsStatus = useSyncExternalStore(
    threadManager.threadsStatus.subscribe,
    threadManager.threadsStatus.get,
  );

  // Fetch entity (Suspense-based — resolved before render)
  const entity = useVirtualMCP(virtualMcpId);

  const hasActiveGithubRepo = !!(entity && getActiveGithubRepo(entity));
  const baseBranch = useBaseBranch(entity, null);

  // Ensure the thread row exists for this URL before rendering the chat. On
  // 404 the hook fires COLLECTION_THREADS_CREATE (idempotent) and surfaces a
  // "Creating task…" state until the row is persisted. Without this the
  // chat renders with branch=null because the thread never existed.
  const ensureState = useEnsureTask(
    routeThreadId,
    virtualMcpId,
    // A freshly minted thread lands on an editable draft, never production.
    generatedDraftBranch,
  );

  // Read-only teammate threads: pull the current metadata (githubRepo /
  // sandboxMap bound by load_repo after the panel snapshot) so the preview
  // doesn't render "no source" / miss the owner's sandbox. No-op for own
  // threads. Must run before the early returns (Rules of Hooks).
  useRefreshViewedThreadMetadata(
    ensureState.status === "ready" ? ensureState.task : null,
  );

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
    const branch =
      threads.find((thread) => thread.id === threadId)?.branch ?? null;
    try {
      await create({
        id: newTaskId,
        virtual_mcp_id: virtualMcpId,
        ...(branch ? { branch } : {}),
      });
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

  const ensuredTask = ensureState.status === "ready" ? ensureState.task : null;
  const ensuredTaskAgentId = ensuredTask?.virtual_mcp_id;
  if (
    ensuredTask &&
    ensuredTaskAgentId &&
    !routeThreadMatchesAgent({
      routeAgentId: virtualMcpId,
      threadAgentId: ensuredTaskAgentId,
    })
  ) {
    const route = canonicalThreadRouteTarget({
      org: orgSlug,
      agentId: ensuredTaskAgentId,
      superAgentId: getWellKnownDecopilotVirtualMCP(org.id).id,
    });
    return (
      <LegacyCanonicalNavigate
        target={{
          route,
          search: {
            thread: ensuredTask.id,
            sidepanel: sessionSearch.sidepanel,
            mainpanel: sessionSearch.mainpanel,
            autosend: sessionSearch.autosend,
          },
        }}
      />
    );
  }

  // Resolve a scoped agent's entry thread HERE, in project scope once loaded — useNavigateToAgent's cross-project manager can't see these threads (#6667); repo agents mint one if none resolves, branchless fall through to the lazy composer, org home (no routeAgentId) stays fresh.
  if (routeThreadId === null && routeAgentId && entity) {
    // Wait for the first thread page: resolving against an empty list would mint a fresh thread and drop the user off their last version/conversation.
    if (threadsStatus.kind === "loading") {
      return (
        <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
          <div
            role="status"
            aria-live="polite"
            className="flex h-full items-center justify-center bg-background card-shadow rounded-[0.75rem] text-sm text-muted-foreground"
          >
            <Spinner className="size-4 mr-2" />
            {t("agentShellLayout.agentShellLayout.creatingTask")}
          </div>
        </div>
      );
    }
    // Resume the last version/conversation for this agent; a repo editor mints a fresh thread when none resolves, a branchless agent falls through to its lazy composer.
    const entry = findAgentEntryThread(
      threads,
      virtualMcpId,
      session?.user?.id,
      defaultThreadRuntime(entity.metadata),
      hasActiveGithubRepo,
      { baseBranch },
    );
    const threadId =
      entry?.id ?? (hasActiveGithubRepo ? generatedThreadId : null);
    if (threadId) {
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
  }

  if (ensureState.status === "creating" || ensureState.status === "loading") {
    return (
      <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
        <div
          role="status"
          aria-live="polite"
          className="flex h-full items-center justify-center bg-background card-shadow rounded-[0.75rem] text-sm text-muted-foreground"
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
    );
  }

  if (!entity) {
    return (
      <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
        <div className="flex flex-col h-full bg-background overflow-hidden card-shadow rounded-[0.75rem]">
          <EmptyState
            image={<AlertCircle size={48} className="text-muted-foreground" />}
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
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Chat.Provider
        key={virtualMcpId}
        virtualMcpId={virtualMcpId}
        task={ensureState.status === "ready" ? ensureState.task : null}
      >
        <VmEventsBridge
          virtualMcpId={virtualMcpId}
          hasActiveGithubRepo={hasActiveGithubRepo}
          sandboxMap={entity.metadata?.sandboxMap}
        >
          <ActiveTaskRuntimeProvider key={providerKey} threadId={threadId}>
            <MainPanelBoundary>
              <ThreadSessionContent
                layout={layout}
                onNewTaskRef={onNewTask}
                createNewTask={createNewTask}
              />
            </MainPanelBoundary>
          </ActiveTaskRuntimeProvider>
        </VmEventsBridge>
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
