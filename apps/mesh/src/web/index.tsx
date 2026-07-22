import { createRoot } from "react-dom/client";
import { StrictMode, Suspense } from "react";
import { Providers } from "@/web/providers/providers";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
  redirect,
} from "@tanstack/react-router";
import { SplashScreen } from "@/web/components/splash-screen";
import { ShellRouteLoading } from "@/web/layouts/shell-route-loading";
import { ChunkErrorBoundary } from "@/web/components/error-boundary";
import { useT } from "@/web/i18n/use-t";
import * as z from "zod";

import "../../index.css";

import { listOrganizationsCached } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { readLastLocation, saveLastLocation } from "@/web/lib/last-location";
import { initPwaInstallCapture } from "@/web/lib/pwa-install";

const rootRoute = createRootRoute({
  component: () => (
    <ChunkErrorBoundary>
      <Suspense fallback={<SplashScreen />}>
        <Outlet />
      </Suspense>
    </ChunkErrorBoundary>
  ),
});

// ============================================
// PUBLIC ROUTES (unchanged)
// ============================================

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: lazyRouteComponent(() => import("./routes/login.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      // Regular login redirect
      next: z.string().optional(),
      // OAuth flow params (passed by Better Auth MCP plugin)
      client_id: z.string().optional(),
      redirect_uri: z.string().optional(),
      response_type: z.string().optional(),
      state: z.string().optional(),
      scope: z.string().optional(),
      code_challenge: z.string().optional(),
      code_challenge_method: z.string().optional(),
    }),
  ),
});

const cliAuthSuccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cli/auth-success",
  component: lazyRouteComponent(() => import("./routes/cli-auth-success.tsx")),
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: lazyRouteComponent(() => import("./routes/reset-password.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      token: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

/**
 * Better auth catchall
 */
const betterAuthRoutes = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/$pathname",
  component: lazyRouteComponent(() => import("./routes/auth-catchall.tsx")),
});

const oauthCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/oauth/callback",
  component: lazyRouteComponent(() => import("./routes/oauth-callback.tsx")),
});

const oauthCallbackAiProviderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/oauth/callback/ai-provider",
  component: lazyRouteComponent(
    () => import("./routes/oauth-callback-ai-provider.tsx"),
  ),
});

// ============================================
// DEPLOYMENT ADMIN DASHBOARD (instance-level, not org-scoped)
// ============================================

// Mounted at `/_admin`, not `/admin`. TanStack ranks the static `/_admin`
// segment above the `$org` param, so this route wins even if an `_admin`
// slug were ever minted (ORGANIZATION_CREATE rejects `_`, but the raw
// better-auth endpoint enforces no charset) — the org gets shadowed, never
// this surface. A bare `/admin` would shadow a legal, live slug.
const adminLayout = createRoute({
  getParentRoute: () => rootRoute,
  path: "/_admin",
  component: lazyRouteComponent(() => import("./routes/admin/layout.tsx")),
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/_admin/users" });
  },
});

const adminUsersRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: "/users",
  component: lazyRouteComponent(() => import("./routes/admin/users.tsx")),
});

const adminOrgsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: "/orgs",
  component: lazyRouteComponent(() => import("./routes/admin/orgs.tsx")),
});

const adminLayoutWithChildren = adminLayout.addChildren([
  adminIndexRoute,
  adminUsersRoute,
  adminOrgsRoute,
]);

// ============================================
// SHELL LAYOUT (authenticated wrapper)
// ============================================

const shellLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: lazyRouteComponent(() => import("./layouts/shell-layout.tsx")),
});

// Home route (landing, redirects to last or only org)
const homeRoute = createRoute({
  getParentRoute: () => shellLayout,
  path: "/",
  beforeLoad: async () => {
    // Restore the last ORG the user was in, but always land on its HOME (the
    // Super Agent) — never resume the last conversation. Cold entry / a fresh
    // tab is a "start from home" gesture (ChatGPT-style), so we deliberately
    // ignore any recorded taskId here. lastLocation's org is recorded on every
    // org-scoped navigation (orgLayout.beforeLoad), so it's current even after
    // an in-app org switch that the queryFn-driven lastOrgSlug can miss. Reads
    // are synchronous so cold entry stays instant. A stale org self-heals:
    // OrgAccessGate clears it and bounces back to "/".
    const lastLocation = readLastLocation();
    if (lastLocation) {
      throw redirect({ to: "/$org", params: { org: lastLocation.org } });
    }

    // Fast path: redirect returning users immediately from the cached slug,
    // WITHOUT awaiting the org-list network call. This is what keeps a cold
    // load from blocking on a round-trip (the previous blank/white screen).
    // The org layout validates membership via getFullOrganization, and a stale
    // slug self-heals in OrgAccessGate (clears the slug + bounces back to "/").
    const lastOrgSlug = localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    if (lastOrgSlug) {
      throw redirect({
        to: "/$org",
        params: { org: lastOrgSlug },
      });
    }

    // No cached slug — fetch the list (cached) to pick a destination.
    const { data: orgs } = await listOrganizationsCached();

    // If the list call failed, skip redirect logic to avoid a misfire on a
    // transient API failure. Archived orgs are already filtered by the helper.
    if (!orgs) return;

    // Redirect to first available org (every user gets a default org on signup)
    const firstOrg = orgs[0];
    if (firstOrg) {
      throw redirect({
        to: "/$org",
        params: { org: firstOrg.slug },
      });
    }

    // No orgs at all — send to onboarding
    throw redirect({ to: "/onboarding" });
  },
});

// Onboarding route (for users with no orgs)
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  beforeLoad: async () => {
    // Archived orgs are already filtered by the helper.
    const { data: orgs } = await listOrganizationsCached();
    if (orgs && orgs.length > 0) {
      throw redirect({ to: "/" });
    }
  },
  component: lazyRouteComponent(() => import("./routes/onboarding.tsx")),
});

const commerceOnboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/commerce-onboarding",
  component: lazyRouteComponent(
    () => import("./routes/commerce-onboarding.tsx"),
  ),
  validateSearch: z.lazy(() =>
    z.object({
      org: z.string().optional(),
      siteUrl: z.string().optional(),
    }),
  ),
});

// Auth-gated commerce report for a scanned domain. The route itself stays
// outside the org shell so login can happen inline over its locked preview.
const reportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/report/$domain",
  component: lazyRouteComponent(() => import("./routes/reports.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      // Reviewer preview password — bypasses the engine's publish gate only.
      key: z.string().optional(),
    }),
  ),
});

// ============================================
// ORG LAYOUT
// ============================================

const orgLayout = createRoute({
  getParentRoute: () => shellLayout,
  path: "/$org",
  // Record the org on every entry/switch (this re-runs whenever the $org param
  // changes). Clears any prior taskId; the thread route re-adds it right after
  // for /$org/$taskId, since this parent beforeLoad runs before the child's.
  beforeLoad: ({ params }) => {
    saveLastLocation({ org: params.org });
  },
  component: lazyRouteComponent(() => import("./layouts/org-layout.tsx")),
});

// ============================================
// ORG SHELL LAYOUT (pathless — sidebar + Toolbar + ChatPrefsProvider for / and /$taskId)
// ============================================

const orgShellLayout = createRoute({
  getParentRoute: () => orgLayout,
  id: "org-shell",
  component: lazyRouteComponent(
    () => import("./layouts/org-shell-layout/index.tsx"),
  ),
});

// ============================================
// AGENT SHELL LAYOUT (pathless — per-task chrome under orgShellLayout)
// ============================================

const agentShellLayout = createRoute({
  getParentRoute: () => orgShellLayout,
  id: "agent-shell",
  // Render the centered panel-area loader (matches the shell's own Suspense
  // fallbacks) while this route loads, instead of the full-screen SplashScreen.
  // The sidebar is already mounted by orgShellLayout, so the pending state
  // covers only the main panel region — no off-center left flash on nav.
  pendingComponent: ShellRouteLoading,
  component: lazyRouteComponent(
    () => import("./layouts/agent-shell-layout/index.tsx"),
  ),
});

// ============================================
// UNIFIED CHAT ROUTES (/$org/$taskId)
// ============================================

const unifiedChatSearchSchema = z.object({
  virtualmcpid: z.string().optional(),
  tab: z.string().optional(),
  sidepanel: z.union([z.literal("chat"), z.literal(0)]).optional(),
  main: z.union([z.string(), z.literal(0)]).optional(),
  /** Open the Library file-preview overlay over the chat (browse-grammar path
   *  "<volume>/<path…>"). Set by clickable org-file refs in agent messages. */
  preview: z.string().optional(),
  id: z.string().optional(),
  toolName: z.string().optional(),
  tasks: z.number().optional(),
  mainOpen: z.number().optional(),
  autosend: z.string().optional(),
  /** Carried from the homepage composer so the new thread's first send
   *  inherits the "Run locally" toggle state. ChatPrefsProvider seeds
   *  runLocally from this on mount. */
  runLocally: z.string().optional(),
  /** Commerce onboarding hand-off: `"1"` mounts the blocking connections modal
   *  over this report route until at least one data source is connected. Dropped
   *  by the modal once the enriching run is triggered. */
  connect: z.coerce.string().optional(),
  /** Commerce onboarding hand-off: the claimed site the connect modal is for,
   *  carried in the URL (same context as `/commerce-onboarding?siteUrl=…`) so the
   *  modal is self-describing. Falls back to the connection's stored metadata. */
  siteUrl: z.string().optional(),
});

const unifiedChatRoute = createRoute({
  getParentRoute: () => agentShellLayout,
  path: "/$taskId",
  validateSearch: unifiedChatSearchSchema,
  // Remember the open thread so cold entry ("/") can restore it. Preloading is
  // off (defaultPreload unset), so this only fires on real navigation.
  beforeLoad: ({ params, search }) => {
    saveLastLocation({
      org: params.org,
      taskId: params.taskId,
      virtualmcpid: search.virtualmcpid,
    });
  },
  component: () => null,
});

// Org index (`/$org`) resolves to the Super Agent's home thread — there's no
// bespoke landing page anymore (see org-home). The `main` search param is kept
// so a deep link into a side panel (e.g. "files" = the Library) survives the
// redirect, mirroring the thread's main-panel tabs.
const orgIndexSearchSchema = z.object({
  main: z.string().optional(),
  connect: z.coerce.string().optional(),
  siteUrl: z.string().optional(),
});

const orgIndexRoute = createRoute({
  getParentRoute: () => orgShellLayout,
  path: "/",
  validateSearch: orgIndexSearchSchema,
  pendingComponent: ShellRouteLoading,
  component: lazyRouteComponent(() => import("./layouts/org-home/index.tsx")),
});

// Library (/$org/files) — the org filesystem browser. Static segment, so it
// outranks the /$taskId param route. `path` is the browse location
// ("<volume>/<dir...>", "" = root); `preview` is an open file's path;
// `skill` is an open skill dir's path (Claude Code skill preview).
const librarySearchSchema = z.object({
  path: z.string().optional(),
  preview: z.string().optional(),
  skill: z.string().optional(),
});

const libraryRoute = createRoute({
  getParentRoute: () => orgShellLayout,
  path: "/files",
  validateSearch: librarySearchSchema,
  pendingComponent: ShellRouteLoading,
  component: lazyRouteComponent(() => import("./layouts/library/index.tsx")),
});

// Task board (/$org/board) — org-owned task board. `task` deep-links a
// specific card's modal open (used by the "open in board" button from a
// linked chat).
const boardSearchSchema = z.object({
  task: z.string().optional(),
});

const boardRoute = createRoute({
  getParentRoute: () => orgShellLayout,
  path: "/board",
  validateSearch: boardSearchSchema,
  component: lazyRouteComponent(() => import("./layouts/task-board/index.tsx")),
});

// ============================================
// SETTINGS LAYOUT (/$org/settings)
// ============================================

const settingsLayout = createRoute({
  getParentRoute: () => orgLayout,
  path: "/settings",
  component: lazyRouteComponent(() => import("./layouts/settings-layout.tsx")),
});

// Per-org install page (/$org/install) — swaps the document manifest to an
// org-branded one so installing here produces a distinct home-screen app for
// the org. Studio itself is installed via the browser's native "Add to Home
// Screen" (the default manifest stays active everywhere else). See
// routes/org-install.tsx and lib/pwa-install.ts.
const orgInstallRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/install",
  component: lazyRouteComponent(() => import("./routes/org-install.tsx")),
});

// Settings index → redirect to /general
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/index-redirect.tsx"),
  ),
});

// Operations: Connections
const connectionsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/connections",
  component: lazyRouteComponent(() => import("./routes/orgs/connections.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      action: z.enum(["create"]).optional(),
      tab: z.enum(["all", "connected"]).optional(),
    }),
  ),
});

const connectionDetailRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/connections/$appSlug",
  component: lazyRouteComponent(
    () => import("./routes/orgs/connection-detail.tsx"),
  ),
  validateSearch: z.lazy(() =>
    z.object({
      tab: z.string().optional(),
    }),
  ),
});

const collectionDetailRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/connections/$appSlug/$collectionName/$itemId",
  component: lazyRouteComponent(
    () => import("./routes/orgs/collection-detail.tsx"),
  ),
  validateSearch: z.lazy(() =>
    z.object({
      replayId: z.string().optional(),
    }),
  ),
});

// Operations: Monitor
const monitoringRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/monitor",
  component: lazyRouteComponent(
    () => import("./routes/orgs/monitoring/index.tsx"),
  ),
  validateSearch: z.lazy(() =>
    z.object({
      tab: z
        .enum(["overview", "audit", "dashboards", "threads", "automations"])
        .default("overview"),
      from: z.string().default("now-30m"),
      to: z.string().default("now"),
      connectionId: z.array(z.string()).optional().default([]),
      virtualMcpId: z.array(z.string()).optional().default([]),
      tool: z.string().default(""),
      status: z.enum(["all", "success", "errors"]).default("all"),
      search: z.string().default(""),
      page: z.number().optional(),
      streaming: z.boolean().default(true),
      propertyFilters: z.string().default(""),
      hideSystem: z.boolean().default(false),
    }),
  ),
});

// Organization settings pages
const settingsGeneralRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/general",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/general.tsx"),
  ),
});

const settingsConnectRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/connect",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/connect.tsx"),
  ),
});

const settingsBrandContextRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/brand-context",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/brand-context.tsx"),
  ),
});

const settingsAiProvidersRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/ai-providers",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/ai-providers.tsx"),
  ),
});

const settingsSecretsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/secrets",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/secrets.tsx"),
  ),
});

const settingsFilesRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/files",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/files.tsx"),
  ),
});

const settingsBucketsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/buckets",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/buckets.tsx"),
  ),
});

const settingsMembersRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/members",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/members.tsx"),
  ),
});

const settingsRolesRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/roles",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/roles.tsx"),
  ),
  validateSearch: z.lazy(() =>
    z.object({
      role: z.string().optional(),
    }),
  ),
});

const settingsSsoRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/sso",
  component: lazyRouteComponent(() => import("./routes/orgs/settings/sso.tsx")),
});

const settingsProfileRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/profile",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/profile.tsx"),
  ),
});

const settingsStoreRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/store",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/store.tsx"),
  ),
});

const settingsRegistryRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/registry",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/registry.tsx"),
  ),
});

const settingsStoreRegistryRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/store/registry",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/store-registry.tsx"),
  ),
});

// ============================================
// UNIFIED CHAT SUB-ROUTES
// ============================================

// Agents list (view all)
const settingsAgentsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/agents",
  component: lazyRouteComponent(() => import("./routes/agents-list.tsx")),
});

const settingsAutomationsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/automations",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/automations.tsx"),
  ),
});

// ============================================
// ROUTE TREE
// ============================================

const settingsWithChildren = settingsLayout.addChildren([
  settingsIndexRoute,
  connectionsRoute,
  connectionDetailRoute,
  collectionDetailRoute,
  settingsAgentsRoute,
  settingsAutomationsRoute,
  monitoringRoute,
  settingsGeneralRoute,
  settingsConnectRoute,
  settingsBrandContextRoute,
  settingsAiProvidersRoute,
  settingsSecretsRoute,
  settingsFilesRoute,
  settingsBucketsRoute,
  settingsMembersRoute,
  settingsRolesRoute,
  settingsSsoRoute,
  settingsProfileRoute,
  settingsStoreRoute,
  settingsStoreRegistryRoute,
  settingsRegistryRoute,
]);

const agentShellWithChildren = agentShellLayout.addChildren([unifiedChatRoute]);

const orgShellWithChildren = orgShellLayout.addChildren([
  orgIndexRoute,
  libraryRoute,
  boardRoute,
  agentShellWithChildren,
]);

const orgLayoutWithChildren = orgLayout.addChildren([
  orgShellWithChildren,
  settingsWithChildren,
  orgInstallRoute,
]);

const shellRouteTree = shellLayout.addChildren([
  homeRoute,
  orgLayoutWithChildren,
]);

const routeTree = rootRoute.addChildren([
  shellRouteTree,
  adminLayoutWithChildren,
  onboardingRoute,
  commerceOnboardingRoute,
  reportRoute,
  loginRoute,
  cliAuthSuccessRoute,
  resetPasswordRoute,
  betterAuthRoutes,
  oauthCallbackRoute,
  oauthCallbackAiProviderRoute,
]);

function DefaultNotFoundComponent() {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-4 p-8">
        <h3 className="text-lg font-medium text-foreground">
          {t("common.index.pageNotFound")}
        </h3>
        <p className="text-sm text-muted-foreground text-center max-w-[300px]">
          {t("common.index.pageNotFoundDescription")}
        </p>
        <button
          type="button"
          onClick={() => window.history.back()}
          className="text-sm text-primary hover:underline"
        >
          {t("common.index.goBack")}
        </button>
      </div>
    </div>
  );
}

const router = createRouter({
  routeTree,
  // Show the splash (not a blank screen) while a route loader/beforeLoad is
  // awaiting — e.g. the new-user org-list fetch. 200ms delay avoids a flash on
  // instant (synchronous) redirects like the returning-user fast path.
  defaultPendingComponent: SplashScreen,
  defaultPendingMs: 200,
  defaultNotFoundComponent: DefaultNotFoundComponent,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Capture the Chromium install prompt as early as possible so the /install
// page can offer a one-click install. Fires once shortly after load.
initPwaInstallCapture();

const rootElement = document.getElementById("root")!;

createRoot(rootElement).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
