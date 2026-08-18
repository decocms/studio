import { Suspense, useEffect, useState } from "react";
import type { CmsEditingMode } from "@/sdk/cms-mode";
import { OrgAccessGate } from "@/components/org-access-gate";
import { SplashScreen } from "@/components/splash-screen";
import { FloatingReleaseCard } from "@/components/release-channel/floating-release-card";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { VersionCheckDialog } from "@/components/version-check-dialog";
import { LanguageAnnouncementDialog } from "@/components/language-announcement-dialog";
import { isModKey } from "@/lib/keyboard-shortcuts";
import RequiredAuthLayout from "@/layouts/required-auth-layout";
import { authClient } from "@/lib/auth-client";
import { AUTOSEND_QUERY_VALUE } from "@/lib/autosend";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import type { SidePanelKind } from "@/hooks/use-layout-state";
import { readCachedOrg, writeCachedOrg } from "@/lib/query-persist";
import { PostHogGroupSync } from "@/providers/posthog-group-sync";
import {
  getWellKnownDecopilotVirtualMCP,
  mcpClientQueryOptions,
  ProjectContextProvider,
  SELF_MCP_ALIAS_ID,
  useProjectContext,
} from "@/sdk";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  Outlet,
  useMatch,
  useNavigate,
  useParams,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import { KEYS } from "../lib/query-keys";
import { useOptionalThreadManager } from "@/components/chat/store/hooks";
import { resolveTaskSwitchSearch } from "@/layouts/resolve-task-switch-search";
import { readThreadLayout, saveThreadLayout } from "@/lib/thread-layout-memory";
import { useOrganizationSettingsNonBlocking } from "../hooks/use-organization-settings";
import { homeNextActionsQueryOptions } from "../hooks/use-home-next-actions";
import { useOrgSsoStatus } from "../hooks/use-org-sso";
import { SsoRequiredScreen } from "../components/sso-required-screen";
import { ArchivedOrgScreen } from "../components/archived-org-screen";
import { isOrgArchived } from "@decocms/shared/organization/org-archived";

// ---------------------------------------------------------------------------
// ShellProjectProvider — fetches org settings and provides project context.
// SSO enforcement MUST stay in ShellLayoutContent, above all child rendering.
// ---------------------------------------------------------------------------

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
  const orgSettings = useOrganizationSettingsNonBlocking(org.id, org.slug);

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

// ---------------------------------------------------------------------------
// Panel actions — works anywhere in the router tree.
// Only updates URL search params. The UnifiedPanelGroup useEffect syncs
// the visual panel layout from the querystring-derived state.
// ---------------------------------------------------------------------------

export function usePanelActions() {
  const navigate = useNavigate();
  // Optional: the settings route tree has no ThreadManagerProvider, so this is
  // null there. Navigation actions work regardless; only createNewTask needs it.
  const manager = useOptionalThreadManager();
  const { org } = useProjectContext();

  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const search = useSearch({ strict: false }) as {
    virtualmcpid?: string;
    main?: string | 0;
    sidepanel?: SidePanelKind | 0;
    mode?: CmsEditingMode;
  };
  const orgSlug = params.org ?? "";
  const currentTaskId = params.taskId ?? "";

  const navWith = (
    taskId: string,
    searchFn: (prev: Record<string, unknown>) => Record<string, unknown>,
    replace = true,
  ) =>
    navigate({
      to: "/$org/$taskId",
      params: { org: orgSlug, taskId },
      search: searchFn,
      replace,
    });

  const nav = (
    searchFn: (prev: Record<string, unknown>) => Record<string, unknown>,
    replace = true,
  ) => navWith(currentTaskId, searchFn, replace);

  const openSidePanel = (sidePanel: SidePanelKind) =>
    nav((prev) => ({ ...prev, sidepanel: sidePanel }));

  const setTaskId = (
    id: string,
    virtualMcpId?: string,
    opts?: { autosend?: boolean; main?: string },
  ) => {
    const isSameThread = !!currentTaskId && currentTaskId === id;
    // Remember the layout of the thread we're leaving so returning to it
    // restores the same tabs/side-panel instead of the agent default.
    if (currentTaskId && !isSameThread) {
      saveThreadLayout(currentTaskId, {
        main: search.main,
        sidepanel: search.sidepanel,
        mode: search.mode,
      });
    }
    // Restore the target thread's own remembered layout (null when unseen this
    // session, or when re-selecting the current thread — then keep its URL).
    const savedLayout = isSameThread ? null : readThreadLayout(id);
    const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;

    return navWith(
      id,
      (prev) =>
        resolveTaskSwitchSearch({
          prev: prev as { virtualmcpid?: unknown; main?: unknown },
          virtualMcpId,
          decopilotId,
          savedLayout,
          opts,
          autosendValue: AUTOSEND_QUERY_VALUE,
        }),
      false,
    );
  };

  // Create the row before navigating so the route loader does not race its
  // create-on-404 fallback.
  //
  // `virtualMcpId` lets callers (e.g. the per-group "+" in the sidebar) pin
  // the thread to a specific agent regardless of the current URL. When
  // omitted, falls back to the URL's `virtualmcpid`, then to the well-known
  // Decopilot agent.
  //
  // `branch` lets a "New chat on the branch I'm viewing" caller inherit the
  // current thread's branch. When omitted/null (e.g. a branchless agent, or an
  // "open agent X" flow), the server picks the most-recently-touched branch from
  // the user's sandboxMap. The schema only accepts a non-empty branch string, so
  // null/empty is dropped.
  /** `opts` forwards straight to `setTaskId` (e.g. to pin the new thread's landing tab). */
  const createNewTask = async (
    virtualMcpId?: string,
    branch?: string | null,
    opts?: { main?: string },
  ) => {
    const newId = crypto.randomUUID();
    const targetVmcp =
      virtualMcpId ??
      search.virtualmcpid ??
      getWellKnownDecopilotVirtualMCP(org.id).id;
    try {
      // No manager (settings tree): skip the eager create and let the
      // /$org/$taskId route loader's ensure-fallback create the thread.
      await manager?.create({
        id: newId,
        virtual_mcp_id: targetVmcp,
        ...(branch ? { branch } : {}),
      });
    } catch {
      // Toast already fired by useCollectionActions; navigate anyway so the
      // route loader's ensure-fallback can retry.
    }
    setTaskId(newId, targetVmcp, opts);
  };

  const openTab = (tabId: string) =>
    navWith(currentTaskId || crypto.randomUUID(), (prev) => ({
      ...prev,
      main: tabId,
    }));

  return {
    openSidePanel,
    setTaskId,
    createNewTask,
    openTab,
  };
}

// ---------------------------------------------------------------------------
// ShellLayoutContent — auth, org activation, SSO enforcement, keyboard shortcuts.
// Child routes (agent or settings) render their own sidebar + inset layout.
// ---------------------------------------------------------------------------

function ShellLayoutContent() {
  const orgMatch = useMatch({ from: "/shell/$org", shouldThrow: false });
  const org = orgMatch?.params.org;
  const { taskId } = useParams({ strict: false }) as { taskId?: string };
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const router = useRouter();

  useQuery({
    ...homeNextActionsQueryOptions(org ?? ""),
    enabled: !!org && !taskId,
  });

  // Session is guaranteed present here (this renders inside <SignedIn>), so the
  // user id is available synchronously to scope the org cache by principal.
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const cachedOrg = org && userId ? readCachedOrg(userId, org) : null;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — subscribes to document keydown for ⌘K / ⌘[ shortcuts; DOM event listener has no React 19 alternative
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (isModKey(e) && e.code === "KeyK") {
        e.preventDefault();
        setShortcutsDialogOpen(true);
        return;
      }
      // ⌘[ / Ctrl+[ — back to the previous thread. Own the chord (preventDefault)
      // so it uses SPA history instead of a full browser navigation; skip when
      // there's nothing to go back to so cold entry doesn't leave the app.
      if (
        isModKey(e) &&
        e.code === "BracketLeft" &&
        router.history.canGoBack()
      ) {
        e.preventDefault();
        router.history.back();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [router]);

  const { data: activeOrg } = useSuspenseQuery({
    queryKey: KEYS.activeOrganization(org),
    queryFn: async () => {
      if (!org) {
        return null;
      }

      // Fetch org data without persisting it as the session's active org.
      // Per Better Auth's org plugin docs, persisting active org to the
      // session breaks multi-tab usage because the session row is shared
      // across tabs. We rely on the URL slug (mounted under /api/:org/...)
      // for org resolution instead.
      // Marked for the perf_app_bootstrap timing event (see posthog-client).
      performance.mark("mesh:active-org-fetch:start");
      const { data } = await authClient.organization
        .getFullOrganization({
          query: { organizationSlug: org },
        })
        .finally(() => {
          performance.mark("mesh:active-org-fetch:end");
          performance.measure(
            "mesh:active-org-fetch",
            "mesh:active-org-fetch:start",
            "mesh:active-org-fetch:end",
          );
        });

      // Don't persist archived orgs — homeRoute would just redirect off them again
      const isArchived = isOrgArchived(data);

      // Persist for fast redirect on next login (read by homeRoute beforeLoad)
      // Only write on success and only for active (non-archived) orgs
      if (data && !isArchived) {
        localStorage.setItem(LOCALSTORAGE_KEYS.lastOrgSlug(), org);
      }

      // Seed the user-scoped cache so the next refresh renders instantly.
      if (userId && data) {
        writeCachedOrg(userId, org, data);
      }

      return data;
    },
    // Hydrate from the user-scoped cache so the shell paints without waiting on
    // the network; the stale `initialDataUpdatedAt` triggers a background
    // refetch that flips to the access gate if membership was revoked.
    initialData: cachedOrg
      ? (cachedOrg.data as Awaited<
          ReturnType<typeof authClient.organization.getFullOrganization>
        >["data"])
      : undefined,
    initialDataUpdatedAt: cachedOrg?.updatedAt,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Check org-level SSO enforcement (must be before early returns to satisfy Rules of Hooks)
  const orgId = activeOrg?.id;
  const orgSlug = activeOrg?.slug;
  const { data: ssoStatus } = useOrgSsoStatus(orgId, orgSlug);

  // Warm the self-MCP connection in parallel with the rest of shell bootstrap,
  // so the home's useMCPClient resolves without waiting on a fresh connect()
  // round-trip after it mounts. Non-suspense (useQuery) — this only pre-warms
  // the shared cache entry (same key as useMCPClient via mcpClientQueryOptions);
  // it never blocks paint, and no-ops if the connect doesn't finish first.
  useQuery({
    ...mcpClientQueryOptions({
      connectionId: SELF_MCP_ALIAS_ID,
      orgId: orgId ?? "",
      orgSlug: orgSlug ?? "",
    }),
    enabled: !!orgId && !!orgSlug,
  });

  if (!activeOrg) {
    // Not a member: figure out which screen to show (no-access / pending
    // invite / auto-domain-join / not-found). Wrapped in Suspense so the
    // brief access-status fetch shows the splash instead of throwing back to
    // the parent suspense boundary.
    return (
      <Suspense fallback={<SplashScreen />}>
        <OrgAccessGate orgSlug={org!} />
      </Suspense>
    );
  }

  const isArchivedOrg = isOrgArchived(activeOrg);
  if (isArchivedOrg) {
    // Clear stale slug so /home redirect doesn't bounce the user back here
    if (localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug()) === org) {
      localStorage.removeItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    }
    return <ArchivedOrgScreen orgName={activeOrg.name} />;
  }

  if (ssoStatus?.ssoRequired && !ssoStatus.authenticated) {
    return (
      <SsoRequiredScreen
        orgId={activeOrg.id}
        orgSlug={activeOrg.slug}
        orgName={activeOrg.name}
        domain={ssoStatus.domain}
      />
    );
  }

  return (
    <ShellProjectProvider org={{ ...activeOrg, logo: activeOrg.logo ?? null }}>
      <PostHogGroupSync activeOrg={activeOrg} />
      <Outlet />

      <div className="fixed bottom-6 right-6 z-50 flex w-[min(360px,calc(100vw-3rem))] flex-col gap-3">
        <FloatingReleaseCard />
        <VersionCheckDialog />
      </div>

      {/* Keyboard Shortcuts Dialog */}
      <KeyboardShortcutsDialog
        open={shortcutsDialogOpen}
        onOpenChange={setShortcutsDialogOpen}
      />

      <LanguageAnnouncementDialog />
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
