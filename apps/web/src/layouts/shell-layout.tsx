import { useEffect, useState } from "react";
import { OrgAccessGate } from "@/components/org-access-gate";
import { FloatingReleaseCard } from "@/components/release-channel/floating-release-card";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { CommandPalette } from "@/components/command-palette";
import {
  closeCommandPalette,
  openCommandPalette,
  useCommandPaletteOpen,
} from "@/components/command-palette-store";
import { VersionCheckDialog } from "@/components/version-check-dialog";
import { LanguageAnnouncementDialog } from "@/components/language-announcement-dialog";
import { isModKey, isTypingTarget } from "@/lib/keyboard-shortcuts";
import RequiredAuthLayout from "@/layouts/required-auth-layout";
import { authClient } from "@/lib/auth-client";
import { AUTOSEND_QUERY_VALUE } from "@/lib/autosend";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
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
  useRouter,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import {
  useRouteAgentId,
  useRouteThreadId,
  useRouteVirtualMcpId,
  useThreadNavigate,
} from "@/layouts/thread-route";
import { KEYS } from "../lib/query-keys";
import { useOptionalThreadManager } from "@/components/chat/store/hooks";
import { resolveTaskSwitchSearch } from "@/layouts/resolve-task-switch-search";
import {
  useActivePanelTabId,
  usePanelNavigate,
} from "@/layouts/main-panel-tabs/use-panel-navigate";
import { readThreadLayout, saveThreadLayout } from "@/lib/thread-layout-memory";
import { useOrganizationSettingsNonBlocking } from "../hooks/use-organization-settings";
import { homeNextActionsQueryOptions } from "../hooks/use-home-next-actions";
import { useOrgSsoStatus } from "../hooks/use-org-sso";
import { SsoRequiredScreen } from "../components/sso-required-screen";
import { ArchivedOrgScreen } from "../components/archived-org-screen";
import { BlockedOrgScreen } from "../components/blocked-org-screen";
import { useOrgNotice } from "../hooks/use-org-notice";
import { isBillingEscapeHatch } from "../lib/org-block-escape";
import { isOrgArchived } from "@decocms/shared/organization/org-archived";

/** What `getFullOrganization` resolves to — named so the cache seed below can
 *  be typed against it in one place. */
type ActiveOrgData = Awaited<
  ReturnType<typeof authClient.organization.getFullOrganization>
>["data"];

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
// ---------------------------------------------------------------------------

/**
 * Layout actions only update search (`to: "."`, so they stay on the matched
 * route); thread switches go through `useThreadNavigate`. The UnifiedPanelGroup
 * effect syncs the visual panel layout from the querystring-derived state.
 */
export function usePanelActions() {
  const navigate = useNavigate();
  // Optional: the settings route tree has no ThreadManagerProvider, so this is
  // null there. Navigation actions work regardless; only createNewTask needs it.
  const manager = useOptionalThreadManager();
  const { org } = useProjectContext();

  const search = useSearch({ strict: false }) as {
    mainpanel?: boolean;
    sidepanel?: boolean;
  };
  const activeTabId = useActivePanelTabId();
  const { openPanel, closePanel } = usePanelNavigate();
  /** The agent the route NAMES — undefined on an org-level destination, which
   *  belongs to the Super Agent and so records no agent anywhere. */
  const routeAgentId = useRouteAgentId();
  const currentTaskId = useRouteThreadId();
  const routeVirtualMcpId = useRouteVirtualMcpId();
  const navigateThread = useThreadNavigate();

  /**
   * Search-only navigation: `to: "."` re-interpolates the matched route's own
   * path params, so a panel/tab change stays on the current page and can never
   * fabricate a thread id.
   */
  const navSearch = (
    searchFn: (prev: Record<string, unknown>) => Record<string, unknown>,
    replace = true,
  ) => navigate({ to: ".", search: searchFn, replace });

  const openSidePanel = () =>
    navSearch((prev) => ({ ...prev, sidepanel: true }));

  const setTaskId = (
    id: string,
    virtualMcpId?: string,
    opts?: { autosend?: boolean; panel?: string },
  ) => {
    const isSameThread = !!currentTaskId && currentTaskId === id;
    // Remember the layout of the thread we're leaving so returning to it
    // restores the same tabs/side-panel instead of the agent default.
    if (currentTaskId && !isSameThread) {
      saveThreadLayout(currentTaskId, {
        tab: activeTabId,
        mainpanel: search.mainpanel,
        sidepanel: search.sidepanel,
      });
    }
    // Restore the target thread's own remembered layout (null when unseen this
    // session, or when re-selecting the current thread — then keep its URL).
    const savedLayout = isSameThread ? null : readThreadLayout(id);
    const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;

    const target = resolveTaskSwitchSearch({
      /** The source agent is the one the ROUTE names, never a search param a previous navigation left behind — a stale one misreports the agent we're switching AWAY from, and the carry-forward view rides on that comparison. */
      prev: { virtualmcpid: routeAgentId, tabId: activeTabId },
      virtualMcpId,
      decopilotId,
      savedLayout,
      opts,
      autosendValue: AUTOSEND_QUERY_VALUE,
    });

    return navigateThread(
      id,
      () => target.search,
      /** A thread belongs to one agent, so switching to another project's thread moves the `{-$project}` segment with it — and the view it lands on moves with it too. */
      { virtualMcpId, view: { tabId: target.tabId } },
    );
  };

  /**
   * Create the row before navigating so the route loader does not race its
   * create-on-404 fallback.
   *
   * `virtualMcpId` lets callers (e.g. the per-group "+" in the sidebar) pin the
   * thread to a specific agent regardless of the current URL. When omitted, the
   * route answers — `useRouteVirtualMcpId` reads the `{-$project}` segment
   * first, so a new chat on a project belongs to that project.
   *
   * `branch` lets a "New chat on the branch I'm viewing" caller inherit the
   * current thread's branch. When omitted/null (e.g. a branchless agent, or an
   * "open agent X" flow), the server picks the most-recently-touched branch from
   * the user's sandboxMap. The schema only accepts a non-empty branch string, so
   * null/empty is dropped.
   *
   * `opts` forwards straight to `setTaskId` (e.g. to pin the new thread's landing tab).
   */
  const createNewTask = async (
    virtualMcpId?: string,
    branch?: string | null,
    opts?: { panel?: string },
  ) => {
    const newId = crypto.randomUUID();
    const targetVmcp = virtualMcpId ?? routeVirtualMcpId;
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

  return {
    openSidePanel,
    setTaskId,
    createNewTask,
    /** Changing which view is showing is not a reason to mint a thread. */
    openTab: openPanel,
    closeTab: closePanel,
  };
}

/**
 * The two routes that land on the home overview: the `/$org` resolver and the
 * `/$org/home` destination it resolves to. Matching on the route rather than on
 * "this URL has no taskId" keeps the prefetch off every other destination,
 * none of which carries a thread in its path either.
 */
const HOME_ROUTE_FULL_PATHS = new Set(["/$org/", "/$org/home"]);

function useIsHomeRoute(): boolean {
  return useRouterState({
    select: (state) => {
      const fullPath = state.matches.at(-1)?.fullPath;
      return fullPath !== undefined && HOME_ROUTE_FULL_PATHS.has(fullPath);
    },
  });
}

// ---------------------------------------------------------------------------
// ShellLayoutContent — auth, org activation, SSO enforcement, keyboard shortcuts.
// Child routes (agent or settings) render their own sidebar + inset layout.
// ---------------------------------------------------------------------------

function ShellLayoutContent() {
  const orgMatch = useMatch({ from: "/shell/$org", shouldThrow: false });
  const org = orgMatch?.params.org;
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useCommandPaletteOpen();
  const router = useRouter();
  const isHomeRoute = useIsHomeRoute();

  useQuery({
    ...homeNextActionsQueryOptions(org ?? ""),
    enabled: !!org && isHomeRoute,
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
        /** The module-scope opener, not the setter this component reads with:
         *  a store write needs no subscription, and it keeps the effect's
         *  dependency list to the router. */
        openCommandPalette();
        return;
      }
      /** "?" opens the shortcuts sheet that ⌘K used to; ignored while typing. */
      if (e.key === "?" && !isTypingTarget(e.target)) {
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
    /** Boot is the only moment this query may suspend, and the splash is the
     *  right loader then because no shell is on screen yet. Its key carries the
     *  org slug, so an org SWITCH re-resolves it — but that happens inside the
     *  router's transition, on a boundary that is already mounted, so React
     *  keeps the painted shell up instead of dropping to the fallback. That is
     *  the property `loading-states.spec.ts` pins; if a future change remounts
     *  this boundary, the splash comes back on top of a painted shell.
     *
     *  Hydrating from the user-scoped cache keeps a reload of a known org off
     *  the network entirely. The stale `initialDataUpdatedAt` still triggers a
     *  background refetch, which flips to the access gate if membership was
     *  revoked. */
    initialData: cachedOrg ? (cachedOrg.data as ActiveOrgData) : undefined,
    initialDataUpdatedAt: cachedOrg?.updatedAt,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Check org-level SSO enforcement (must be before early returns to satisfy Rules of Hooks)
  const orgId = activeOrg?.id;
  const orgSlug = activeOrg?.slug;
  const { data: ssoStatus } = useOrgSsoStatus(orgId, orgSlug);
  const ssoBlocked = !!ssoStatus?.ssoRequired && !ssoStatus.authenticated;

  /** A blocked org (billing notice) shows the notice instead of itself —
   *  except on billing, which stays reachable so the org can settle it. The
   *  server enforces the same block on writes; this is the screen for it. */
  const { data: orgNotice } = useOrgNotice(orgSlug);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const orgBlocked =
    orgNotice?.severity === "block" && !isBillingEscapeHatch(pathname);

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

  /** Below this line the shell may return a gate screen instead of itself, and
   *  none of them mount the palette — so drop any flag ⌘K set on the way in. */
  if (!activeOrg || isOrgArchived(activeOrg) || ssoBlocked || orgBlocked) {
    closeCommandPalette();
  }

  if (!activeOrg) {
    /** Not a member: figure out which screen to show (no-access / pending
     *  invite / auto-domain-join / not-found). No boundary of its own — the
     *  brief access-status fetch suspends up to the app's single splash
     *  boundary, which is the same splash a local fallback used to draw and one
     *  element fewer to remount (`layouts/boot-gate.tsx`). */
    return <OrgAccessGate orgSlug={org!} />;
  }

  const isArchivedOrg = isOrgArchived(activeOrg);
  if (isArchivedOrg) {
    // Clear stale slug so /home redirect doesn't bounce the user back here
    if (localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug()) === org) {
      localStorage.removeItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    }
    return <ArchivedOrgScreen orgName={activeOrg.name} />;
  }

  if (orgBlocked && orgNotice) {
    return <BlockedOrgScreen notice={orgNotice} orgSlug={activeOrg.slug} />;
  }

  if (ssoBlocked) {
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

      {/* Mounted only while open: this sits outside every Suspense boundary
          but the root, so nothing here may suspend — the palette's search
          client is non-blocking for that reason. The ⌘K binding lives above,
          so gating the mount does not lose it. */}
      {paletteOpen && (
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      )}

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
