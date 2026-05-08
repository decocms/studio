import { useEffect, useState } from "react";
import { SplashScreen } from "@/web/components/splash-screen";
import { KeyboardShortcutsDialog } from "@/web/components/keyboard-shortcuts-dialog";
import { isModKey } from "@/web/lib/keyboard-shortcuts";
import RequiredAuthLayout from "@/web/layouts/required-auth-layout";
import { authClient } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { PostHogGroupSync } from "@/web/providers/posthog-group-sync";
import { ProjectContextProvider, useProjectContext } from "@decocms/mesh-sdk";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  Outlet,
  useMatch,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { KEYS } from "../lib/query-keys";
import { readCachedTaskBranch } from "../lib/read-cached-task-branch";
import { useTaskActions } from "../hooks/use-tasks";
import { useOrganizationSettingsSuspense } from "../hooks/use-organization-settings";
import { useOrgSsoStatus } from "../hooks/use-org-sso";
import { SsoRequiredScreen } from "../components/sso-required-screen";
import { ArchivedOrgScreen } from "../components/archived-org-screen";

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
  const orgSettings = useOrganizationSettingsSuspense(org.id, org.slug);

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
  const queryClient = useQueryClient();
  const taskActions = useTaskActions();
  const { locator } = useProjectContext();

  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
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

  const setChatOpen = (open: boolean) =>
    nav((prev) => ({ ...prev, chat: open ? 1 : 0 }));

  const setTasksOpen = (open: boolean) =>
    nav((prev) => ({ ...prev, tasks: open ? 1 : 0 }));

  const setTaskId = (id: string, virtualMcpId?: string) =>
    navWith(
      id,
      (prev) => {
        const next: Record<string, unknown> = { chat: 1 };
        if (virtualMcpId) next.virtualmcpid = virtualMcpId;
        else if (prev.virtualmcpid) next.virtualmcpid = prev.virtualmcpid;
        if (prev.tasks) next.tasks = prev.tasks;
        // Preserve the main panel tab (git / preview / env / …) so that
        // switching tasks keeps the user's current view.
        if (prev.main) next.main = prev.main;
        return next;
      },
      false,
    );

  // Create a new task carrying the current task's branch (if any) so the
  // new thread lands on the same warm sandbox. Server picks from vmMap when
  // no branch is provided. Awaiting the create avoids the route loader's
  // create-on-404 fallback firing without a branch hint.
  const createNewTask = async () => {
    const newId = crypto.randomUUID();
    const branch = readCachedTaskBranch(queryClient, locator, currentTaskId);
    const targetVmcp = search.virtualmcpid;
    try {
      await taskActions.create.mutateAsync({
        id: newId,
        ...(targetVmcp ? { virtual_mcp_id: targetVmcp } : {}),
        ...(branch ? { branch } : {}),
      });
    } catch {
      // Toast already fired by useCollectionActions; navigate anyway so the
      // route loader's ensure-fallback can retry.
    }
    setTaskId(newId);
  };

  const openTab = (tabId: string) =>
    navWith(currentTaskId || crypto.randomUUID(), (prev) => ({
      ...prev,
      main: tabId,
    }));

  const toggleMain = () =>
    nav((prev) => {
      const isOpen = prev.main !== undefined && prev.main !== "0";
      if (isOpen) {
        return { ...prev, main: "0" };
      }
      const next: Record<string, unknown> = { ...prev };
      delete next.main;
      return next;
    });

  return {
    setChatOpen,
    setTasksOpen,
    setTaskId,
    createNewTask,
    openTab,
    toggleMain,
  };
}

// ---------------------------------------------------------------------------
// ShellLayoutContent — auth, org activation, SSO enforcement, keyboard shortcuts.
// Child routes (agent or settings) render their own sidebar + inset layout.
// ---------------------------------------------------------------------------

function ShellLayoutContent() {
  const orgMatch = useMatch({ from: "/shell/$org", shouldThrow: false });
  const org = orgMatch?.params.org;
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
      const { data } = await authClient.organization.getFullOrganization({
        query: { organizationSlug: org },
      });

      // Don't persist archived orgs — homeRoute would just redirect off them again
      const isArchived =
        (data as { metadata?: { archived?: boolean } } | null)?.metadata
          ?.archived === true;

      // Persist for fast redirect on next login (read by homeRoute beforeLoad)
      // Only write on success and only for active (non-archived) orgs
      if (data && !isArchived) {
        localStorage.setItem(LOCALSTORAGE_KEYS.lastOrgSlug(), org);
      }

      return data;
    },
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Check org-level SSO enforcement (must be before early returns to satisfy Rules of Hooks)
  const orgId = activeOrg?.id;
  const orgSlug = activeOrg?.slug;
  const { data: ssoStatus } = useOrgSsoStatus(orgId, orgSlug);

  if (!activeOrg) {
    return <SplashScreen />;
  }

  const isArchivedOrg =
    (activeOrg as { metadata?: { archived?: boolean } }).metadata?.archived ===
    true;
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
