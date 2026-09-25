import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  retainSearchParams,
} from "@tanstack/react-router";
import { PanelLoading } from "@/layouts/main-panel-boundary";
import {
  mainPanelSearchSchema,
  sidePanelSearchSchema,
} from "@/layouts/panel-search";
import { settingsGroupPendingComponent } from "@/components/settings/settings-group-page";
import { ChunkErrorBoundary } from "@/components/error-boundary";
import { useT } from "@/i18n/use-t";
import * as z from "zod";

import { listOrganizationsCached } from "@/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { readLastLocation, saveLastLocation } from "@/lib/last-location";
import {
  canonicalProjectPathFromLegacyAgents,
  isCanonicalAgentIdSegment,
  promoteLegacyTaskParam,
} from "@/lib/legacy-route-translation";
import {
  legacyWorkspaceCompatibilitySearchSchema,
  legacyWorkspaceCompatibilitySearchShape,
  librarySearchShape,
  siteEditorContentSearchShape,
  taskBoardSearchShape,
} from "@/lib/legacy-workspace-search";

const rootRoute = createRootRoute({
  /** No `<Providers>` here: each entry (`index.web.tsx`, `index.native.tsx`)
   *  wraps `<RouterProvider>` in it instead, so router-level code can reach the
   *  providers too. Wrapping in both places would mount them twice.
   *
   *  No `Suspense` of its own either: the app's ONE splash boundary is in
   *  `providers/providers.tsx`, above `<RouterProvider>`, and a second boundary
   *  here would mount a second `SplashScreen` the moment the first resolved —
   *  see `layouts/boot-gate.tsx`. Every match already wraps its own component in
   *  its `pendingComponent` (`PanelLoading` by default), so what reaches this
   *  level is a suspension no route owns, and that belongs to the boot
   *  boundary. */
  component: () => (
    <ChunkErrorBoundary>
      <Outlet />
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
      // WhatsApp Concierge attribution (e.g. ?src=wa&ref=<leadId>)
      src: z.string().optional(),
      ref: z.string().optional(),
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

/**
 * Mounted at `/_admin`, not `/admin`. TanStack ranks the static `/_admin`
 * segment above the `$org` param, so this route wins even if an `_admin`
 * slug were ever minted (ORGANIZATION_CREATE rejects `_`, but the raw
 * better-auth endpoint enforces no charset) — the org gets shadowed, never
 * this surface. A bare `/admin` would shadow a legal, live slug. The same
 * ranking rule governs the org tree; see ROUTE GRAMMAR below for the invariant.
 */
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

const adminPromptsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: "/prompts",
  component: lazyRouteComponent(() => import("./routes/admin/prompts.tsx")),
});

const adminGithubRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: "/github",
  // Outcome of GitHub's App Manifest redirect (see the API's manifest callback).
  validateSearch: z.object({
    github_app: z.string().optional().catch(undefined),
  }),
  component: lazyRouteComponent(() => import("./routes/admin/github.tsx")),
});

const adminLayoutWithChildren = adminLayout.addChildren([
  adminIndexRoute,
  adminUsersRoute,
  adminOrgsRoute,
  adminPromptsRoute,
  adminGithubRoute,
]);

// ============================================
// SHELL LAYOUT (authenticated wrapper)
// ============================================

/**
 * The authenticated wrapper. Everything the app shell itself needs — the auth
 * wrapper, the active organization, the sidebar's chunk — resolves at or below
 * this route, but the loader for that window is NOT here: `boot-gate.tsx` holds
 * the app's one splash up through `router.load()`, so this match is already
 * resolved on its first render and never goes pending during boot. That is what
 * makes the splash a single mounted element instead of a relay.
 *
 * A `pendingComponent` here would therefore be a second splash, not a first
 * one. It inherits `PanelLoading` instead, which is the right answer for the
 * only way this match can still go pending: a post-boot re-resolution, with the
 * shell already painted around it.
 */
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
    // org-scoped navigation (orgRoute.beforeLoad), so it's current even after
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

const onboardingSearch = z.lazy(() =>
  z.object({
    org: z.string().optional(),
    siteUrl: z.string().optional(),
    // The report finding whose "fix automatically" button sent the visitor.
    fix: z.string().optional(),
  }),
);

const reportsOnboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reports-onboarding",
  component: lazyRouteComponent(
    () => import("./routes/reports-onboarding.tsx"),
  ),
  validateSearch: onboardingSearch,
});

/**
 * The name this flow shipped under. Kept because the report email's CTA
 * persisted it — Reports stores the URL per (org, site) and re-sends it, so
 * links already in inboxes outlive any rename here. Redirects rather than
 * rendering a second copy, and carries the search through: `siteUrl` is the
 * whole point of the link.
 */
const legacyCommerceOnboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/commerce-onboarding",
  validateSearch: onboardingSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/reports-onboarding", search });
  },
});

// Storefront "." shortcut: resolve (site, domain) → the project's content editor. Root route so login can bounce back with params intact.
const chooseEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/choose-editor",
  component: lazyRouteComponent(() => import("./routes/choose-editor.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      site: z.string().optional(),
      domain: z.string().optional(),
      pageId: z.string().optional(),
      // path/pathTemplate arrive URL-encoded once; TanStack decodes them here.
      path: z.string().optional(),
      pathTemplate: z.string().optional(),
    }),
  ),
});

// Public report, readable without a session — hence outside the org shell.
const reportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/report/$domain",
  component: lazyRouteComponent(() => import("./routes/reports.tsx")),
});

// ============================================
// ORGANIZATION ROUTE — SHARED APPLICATION LAYOUT
// ============================================

const orgRoute = createRoute({
  getParentRoute: () => shellLayout,
  path: "/$org",
  // Record the org on every entry/switch (this re-runs whenever the $org param
  // changes). Cold entry deliberately restores only this organization, never a
  // conversation or route-local workspace state.
  beforeLoad: ({ params }) => {
    saveLastLocation({ org: params.org });
  },
  /** The last route above the sidebar, and the one that mounts it. `boot-gate.tsx`
   *  resolves this match before the router mounts, so it shows no loader during
   *  boot; after boot `beforeLoad` is synchronous and the chunk is cached, so an
   *  org switch resolves it well inside `defaultPendingMs`. Keep it that way —
   *  an async loader here, or anything under `OrgRoute` that suspends, would
   *  put a loading state back on top of a painted shell. */
  component: lazyRouteComponent(() => import("./routes/orgs/route.tsx")),
});

// ============================================
// THREAD ROUTE (pathless — shared thread providers)
// ============================================

const threadRoute = createRoute({
  getParentRoute: () => orgRoute,
  id: "org-shell",
  /** The panel-area loader, NOT the app-wide `SplashScreen`. The sidebar is
   *  `orgRoute`'s now, so this route's pending state covers only the inset —
   *  without this, returning from the settings tree blanked the whole viewport
   *  for as long as this chunk and its providers took, which is the same reason
   *  `threadSessionRoute` below sets it. */
  pendingComponent: PanelLoading,
  component: lazyRouteComponent(() => import("./routes/orgs/thread-route.tsx")),
});

// ============================================
// THREAD SESSION ROUTE (pathless — runtime providers + chat layout state)
// ============================================

/**
 * Layout search, declared once for every route under ThreadSessionRoute.
 *
 * Path = which page. Search = how that page is laid out. `sidepanel`,
 * `mainpanel` and `thread` describe the layout, never the page, so they live
 * here on the pathless parent and no destination route re-declares them. The
 * two panel params are symmetric booleans—whether each panel is open—while the
 * matched child route names the page rendered in Main.
 */
const chatLayoutSearchSchema = z.object({
  /** Whether the chat side panel is open. Absent = the route/agent default,
   *  which is closed on any destination that declares a `defaultMain`. Legacy
   *  `chat`/`0` links parse to the same boolean (see `panel-search.ts`). */
  sidepanel: sidePanelSearchSchema,
  /** Whether the main panel is open. Absent = open whenever the URL names a
   *  view (path segment, route default, then the agent's own default). */
  mainpanel: mainPanelSearchSchema,
  /** LEGACY INPUT ONLY — the view is a path segment and its visibility is
   *  `mainpanel` now. Still arrives from bookmarks and from already-delivered
   *  mail (`tools/reports/setup.ts`, `reports-share.ts`), so it is
   *  accepted here and retired by `<LegacyMainRedirect />`. Nothing writes it. */
  main: z.union([z.string(), z.literal(0)]).optional(),
  /** The open thread on a destination route. The legacy `/$org/$taskId` carries
   *  the same id in its path param instead, so nothing reads both. */
  thread: z.string().optional(),
  /** Cross-route chat hand-offs owned by ThreadSessionRoute. */
  autosend: z.string().optional(),
  /** Mobile Library preview overlay opened from an in-chat file reference. */
  preview: z.string().optional(),
  /** LEGACY INPUT ONLY — canonical agent identity is `$agentId`. Kept on the
   * shared schema so old thread/view links can be translated before removal. */
  virtualmcpid: z.string().optional(),
});

const threadSessionRoute = createRoute({
  getParentRoute: () => threadRoute,
  id: "agent-shell",
  validateSearch: chatLayoutSearchSchema,
  /** Chat visibility follows the person across workspace destinations. Agent
   *  identity never does: canonical agent routes own it in `$agentId`, while
   *  `virtualmcpid` remains an input/filter only on the legacy and org-level
   *  routes that explicitly declare it. */
  search: { middlewares: [retainSearchParams(["sidepanel"])] },
  // Render the centered panel-area loader (matches the shell's own Suspense
  // fallbacks) while this route loads, instead of the full-screen SplashScreen.
  // The sidebar is already mounted by orgRoute, so the pending state
  // covers only the main panel region — no off-center left flash on nav.
  pendingComponent: PanelLoading,
  component: lazyRouteComponent(
    () => import("./routes/thread-session/route.tsx"),
  ),
});

// ============================================
// UNIFIED CHAT ROUTES (/$org/$taskId)
// ============================================

const unifiedChatSearchSchema = legacyWorkspaceCompatibilitySearchSchema.extend(
  {
    virtualmcpid: z.string().optional(),
  },
);

const unifiedChatRoute = createRoute({
  getParentRoute: () => threadSessionRoute,
  path: "/$taskId",
  validateSearch: unifiedChatSearchSchema,
  component: () => null,
});

/**
 * ORGANIZATION AND PROJECT DESTINATIONS
 *
 * ROUTE GRAMMAR — path = which page, search = how that page is laid out.
 *
 * Organization pages are direct children (`home`, `tasks`, `reports`,
 * `library`). Project identity is always the explicit
 * `/projects/$agentId` boundary, and every project feature is a child below it.
 * Site Editor owns a further nested Preview/Content/Code subtree so all three
 * share the existing editor controls and console drawer.
 *
 * Each destination composes ChatLayout.Content around its feature body.
 * ChatLayout owns placement and shared panel controls; ThreadSessionRoute
 * owns the domain providers. `sidepanel`, `mainpanel`, and `thread` remain
 * shared search. Feature payloads live on the leaf that consumes them.
 *
 * Old `?main=` and `?virtualmcpid=` links are permanent inputs, never outputs.
 * The pure legacy translator maps them directly to this tree before an invalid
 * agent identity can mount. The catch-all below exists solely for the briefly
 * shipped project-first grammar.
 *
 * RANKING INVARIANT: TanStack ranks statics above dynamics above optionals at
 * the same position, so `/$org/home`, `/$org/projects` and `/$org/tasks` beat the
 * `/$org/$taskId` sibling exactly as `/$org/settings` already does. But
 * `sortDynamic` returns 0 for two SAME-SHAPE dynamic siblings under one node,
 * and the winner then silently becomes registration order — so never register a
 * second `/$org/$something`.
 *
 * Organization destinations are unconditional: the sidebar links straight to
 * them and `/$org` resolves into Home. Product gates affect agent feature
 * children, never the existence or meaning of organization paths.
 */

/** Keep ChatLayout lazy for settings-only visits. */
const ChatLayoutPending = lazyRouteComponent(
  () => import("./components/chat-layout"),
  "ChatLayoutPending",
);
const ChatLayoutError = lazyRouteComponent(
  () => import("./components/chat-layout"),
  "ChatLayoutError",
);

/** Home is organization-owned. Project identity lives under `/projects/$agentId`. */
const orgHomeRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => threadSessionRoute,
  path: "/home",
  staticData: {
    pageTitle: "sidebar.navDestinations.home",
    defaultMain: "overview",
    mainView: "overview",
  },
  validateSearch: z.object({
    /** Reports onboarding hand-off, forwarded verbatim by the `/$org` resolver. */
    connect: z.coerce.string().optional(),
    siteUrl: z.string().optional(),
  }),
  component: lazyRouteComponent(() => import("./routes/workspace/home.tsx")),
});

/** Bare `/projects` promotes a search-carried legacy identity or lands on the
 *  organization Home. It is an entry point, never a second project list. */
const projectsIndexRoute = createRoute({
  getParentRoute: () => threadSessionRoute,
  path: "/projects",
  validateSearch: legacyWorkspaceCompatibilitySearchSchema,
  beforeLoad: ({ params, search }) => {
    const agentId = search.virtualmcpid?.trim();
    if (!agentId) {
      throw redirect({
        to: "/$org/home",
        params: { org: params.org },
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          virtualmcpid: undefined,
        }),
        hash: true,
        replace: true,
      });
    }
    throw redirect({
      to: "/$org/projects/$agentId",
      params: { org: params.org, agentId },
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        virtualmcpid: undefined,
      }),
      hash: true,
      replace: true,
    });
  },
});

/** Canonical identity boundary for one project. Every feature is a real child
 *  route and therefore owns both its composition and its URL. */
const agentWorkspaceRoute = createRoute({
  errorComponent: ChatLayoutError,
  getParentRoute: () => threadSessionRoute,
  path: "/projects/$agentId",
  validateSearch: legacyWorkspaceCompatibilitySearchSchema,
  component: Outlet,
});

const agentOverviewRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/",
  staticData: {
    pageTitle: "page.overview",
    defaultMain: "overview",
    mainView: "overview",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-overview.tsx"),
  ),
});

const projectTasksRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/tasks/{-$taskKey}",
  staticData: {
    pageTitle: "sidebar.navDestinations.tasks",
    defaultMain: "board",
    mainView: "board",
  },
  validateSearch: z.object({
    task: z.string().optional(),
    ...taskBoardSearchShape,
  }),
  beforeLoad: ({ params, search }) => {
    const promoted = promoteLegacyTaskParam(params.taskKey, search);
    if (!promoted) return;
    throw redirect({
      to: "/$org/projects/$agentId/tasks/{-$taskKey}",
      params: {
        org: params.org,
        agentId: params.agentId,
        taskKey: promoted?.taskKey ?? params.taskKey,
      },
      search: promoted.search,
      hash: true,
      replace: true,
    });
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/project-tasks.tsx"),
  ),
});

const projectReportsRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/reports",
  staticData: {
    pageTitle: "sidebar.navDestinations.reports",
    defaultMain: "reports",
    mainView: "reports",
  },
  validateSearch: z.object({
    connect: z.coerce.string().optional(),
    siteUrl: z.string().optional(),
  }),
  component: lazyRouteComponent(
    () => import("./routes/workspace/project-reports.tsx"),
  ),
});

const agentSiteEditorRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/site-editor",
  staticData: {
    pageTitle: "sidebar.projectNav.siteEditor",
    defaultMain: "site-editor",
    mainView: "site-editor",
  },
  validateSearch: z.object({
    autosend: z.string().optional(),
    ...siteEditorContentSearchShape,
  }),
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-site-editor.tsx"),
  ),
});

const agentSiteEditorIndexRoute = createRoute({
  getParentRoute: () => agentSiteEditorRoute,
  path: "/",
  staticData: {
    defaultMain: "site-editor",
    mainView: "site-editor",
    siteEditorView: "preview",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-site-editor-preview.tsx"),
  ),
});

const agentSiteEditorContentRoute = createRoute({
  getParentRoute: () => agentSiteEditorRoute,
  path: "/content",
  staticData: {
    defaultMain: "content",
    mainView: "content",
    siteEditorView: "content",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-site-editor-content.tsx"),
  ),
});

const agentSiteEditorCodeRoute = createRoute({
  getParentRoute: () => agentSiteEditorRoute,
  path: "/code",
  staticData: {
    defaultMain: "code",
    mainView: "code",
    siteEditorView: "code",
  },
  validateSearch: z.object({ file: z.string().optional() }),
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-site-editor-code.tsx"),
  ),
});

const agentAutomationsRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/automations",
  staticData: {
    pageTitle: "settings.nav.automations",
    defaultMain: "automations",
    mainView: "automations",
  },
  beforeLoad: ({ params, search }) => {
    const automationId = search.automation;
    if (!automationId) return;
    throw redirect({
      to: "/$org/projects/$agentId/automations/$automationId",
      params: { org: params.org, agentId: params.agentId, automationId },
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        automation: undefined,
      }),
      hash: true,
      replace: true,
    });
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-automations.tsx"),
  ),
});

const agentAutomationRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/automations/$automationId",
  staticData: {
    pageTitle: "settings.nav.automations",
    defaultMain: "automations",
    mainView: "automation",
  },
  validateSearch: z.object({
    automationView: z.enum(["settings", "runs"]).optional(),
  }),
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-automation.tsx"),
  ),
});

const agentSettingsRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/settings",
  staticData: {
    pageTitle: "sidebar.navDestinations.settings",
    defaultMain: "settings",
    mainView: "settings",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-settings.tsx"),
  ),
});

const agentAssetsRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/assets",
  staticData: {
    pageTitle: "common.mainPanelTabs.assets",
    defaultMain: "assets",
    mainView: "assets",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-assets.tsx"),
  ),
});

const agentGitRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/git",
  staticData: {
    pageTitle: "common.mainPanelTabs.reviewChanges",
    defaultMain: "git",
    mainView: "git",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-git.tsx"),
  ),
});

const agentHostingRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/hosting",
  staticData: {
    pageTitle: "common.mainPanelTabs.hosting",
    defaultMain: "hosting",
    mainView: "hosting",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-hosting.tsx"),
  ),
});

const agentE2eRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/e2e",
  staticData: {
    pageTitle: "common.mainPanelTabs.e2e",
    defaultMain: "e2e",
    mainView: "e2e",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-e2e.tsx"),
  ),
});

const agentAnalyticsRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/analytics",
  staticData: {
    pageTitle: "common.mainPanelTabs.analytics",
    defaultMain: "analytics",
    mainView: "analytics",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-analytics.tsx"),
  ),
});

const agentExperimentsRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/experiments",
  staticData: {
    defaultMain: "experiments",
    mainView: "experiments",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-experiments.tsx"),
  ),
});

const agentMonitorRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  /** The stable tab id is `cdn`. Keeping that name in the canonical path also
   * leaves the previously unambiguous project-first custom view `monitor`
   * available to the compatibility catch-all below. */
  path: "/cdn",
  staticData: {
    pageTitle: "common.mainPanelTabs.cdn",
    defaultMain: "cdn",
    mainView: "cdn",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-monitor.tsx"),
  ),
});

const agentAppRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/apps/$connectionId/$toolName",
  staticData: { pageTitle: "page.app", defaultMain: "app", mainView: "app" },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-app.tsx"),
  ),
});

const agentViewRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/views/$viewId",
  staticData: { pageTitle: "page.view", defaultMain: "view", mainView: "view" },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-view.tsx"),
  ),
});

const agentOutputFileRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/outputs/file",
  staticData: { pageTitle: "page.file", defaultMain: "file", mainView: "file" },
  validateSearch: z.object({ key: z.string().optional() }),
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-file.tsx"),
  ),
});

const agentOutputDeckRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/outputs/deck",
  staticData: {
    pageTitle: "page.document",
    defaultMain: "deck",
    mainView: "deck",
  },
  validateSearch: z.object({ path: z.string().optional() }),
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-deck.tsx"),
  ),
});

const agentLibraryFileRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/library/file",
  staticData: {
    pageTitle: "page.file",
    defaultMain: "library-file",
    mainView: "library-file",
  },
  validateSearch: z.object({ path: z.string().optional() }),
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-library-file.tsx"),
  ),
});

const agentConnectSourcesRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => agentWorkspaceRoute,
  path: "/connect-sources",
  staticData: {
    pageTitle: "settings.nav.connect",
    defaultMain: "connect-sources",
    mainView: "connect-sources",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/agent-connect-sources.tsx"),
  ),
});

/** Compatibility leaf for the briefly shipped project-first grammar
 *  (`/projects/<project>/<view>`). Static canonical children win route ranking;
 *  the outer workspace adapter translates every remaining view directly to
 *  its canonical route before agent/runtime providers mount. */
const agentLegacyProjectViewRoute = createRoute({
  getParentRoute: () => agentWorkspaceRoute,
  path: "/$legacyView",
  component: () => null,
});

/** `/agents` was the previous canonical namespace. Keep it as a one-hop input
 *  so shared links and browser history survive the terminology change; no
 *  application navigation emits it. Nested paths are preserved verbatim and
 *  then resolved by the canonical project tree's compatibility adapter. */
const legacyAgentsIndexRoute = createRoute({
  getParentRoute: () => threadSessionRoute,
  path: "/agents",
  validateSearch: legacyWorkspaceCompatibilitySearchSchema,
  beforeLoad: ({ params, search }) => {
    const agentId = search.virtualmcpid?.trim();
    throw redirect(
      agentId
        ? {
            to: "/$org/projects/$agentId",
            params: { org: params.org, agentId },
            search: (previous: Record<string, unknown>) => previous,
            hash: true,
            replace: true,
          }
        : {
            to: "/$org/projects",
            params: { org: params.org },
            search: (previous: Record<string, unknown>) => previous,
            hash: true,
            replace: true,
          },
    );
  },
});

const legacyAgentsDeepRoute = createRoute({
  getParentRoute: () => threadSessionRoute,
  path: "/agents/$",
  validateSearch: legacyWorkspaceCompatibilitySearchSchema,
  beforeLoad: ({ params, location }) => {
    const firstSegment = params._splat?.split("/").find(Boolean);
    if (!isCanonicalAgentIdSegment(firstSegment)) return;

    const canonicalPathname = canonicalProjectPathFromLegacyAgents(
      location.pathname,
    );
    if (!canonicalPathname) return;

    const hash = location.hash ? `#${location.hash}` : "";
    throw redirect({
      href: `${canonicalPathname}${location.searchStr}${hash}`,
      replace: true,
    });
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/legacy-agents-deep.tsx"),
  ),
});

/**
 * Task board, and the card a URL opens.
 *
 * `{-$taskKey}` is the card's own address, written as the human key it already
 * shows (`DECO-01`, or a synced card's `EX-333` — see `task-route.ts`); no
 * segment is the lanes. The board's filters stay in search because a filter is
 * how this page is laid out, whereas a card is a thing you open.
 *
 * Agent identity is deliberately absent: Tasks is organization-owned. Opening
 * an agent's chat relocates to that agent's canonical workspace instead of
 * smuggling identity into this route's search.
 */
const tasksRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => threadSessionRoute,
  path: "/tasks/{-$taskKey}",
  staticData: {
    pageTitle: "sidebar.navDestinations.tasks",
    defaultMain: "board",
    mainView: "board",
  },
  validateSearch: z.object({
    /** LEGACY INPUT ONLY — the card is a path segment now. Still arrives from
     *  the `/$org` resolver and from `/$org/$taskId`; `beforeLoad` rewrites it
     *  to the path form. Nothing writes it. */
    task: z.string().optional(),
    /** Board view state, persisted in the URL. See `filters-search.ts`. */
    ...taskBoardSearchShape,
  }),
  beforeLoad: ({ params, search }) => {
    const promoted = promoteLegacyTaskParam(params.taskKey, search);
    if (!promoted) return;
    throw redirect({
      to: "/$org/tasks/{-$taskKey}",
      params: { org: params.org, taskKey: promoted.taskKey },
      search: promoted.search,
      hash: true,
      replace: true,
    });
  },
  component: lazyRouteComponent(() => import("./routes/workspace/tasks.tsx")),
});

/** The task board's Grafana dashboards, in-product. Admin orgs only. */
const taskBoardAnalyticsRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => threadSessionRoute,
  path: "/taskboard-analytics",
  staticData: {
    defaultMain: "board",
    mainView: "board",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/taskboard-analytics.tsx"),
  ),
});

/** Every org's chats and automations, live, with usage and errors. Admin orgs only. */
const threadAnalyticsRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => threadSessionRoute,
  path: "/thread-analytics",
  staticData: {
    defaultMain: "board",
    mainView: "board",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/thread-analytics.tsx"),
  ),
});

/** The org's Reports report. Org-wide, so no project segment. */
const reportsRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => threadSessionRoute,
  path: "/reports",
  staticData: {
    pageTitle: "sidebar.navDestinations.reports",
    defaultMain: "reports",
    mainView: "reports",
  },
  validateSearch: z.object({
    /** `"1"` mounts the blocking connections modal until a data source is
     *  connected; `siteUrl` is the claimed site it is for. */
    connect: z.coerce.string().optional(),
    siteUrl: z.string().optional(),
  }),
  component: lazyRouteComponent(() => import("./routes/workspace/reports.tsx")),
});

/** Library. Org-wide, so no project segment. */
const libraryRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => threadSessionRoute,
  path: "/library",
  staticData: {
    pageTitle: "sidebar.navDestinations.library",
    defaultMain: "files",
    mainView: "files",
  },
  validateSearch: z.object(librarySearchShape),
  component: lazyRouteComponent(() => import("./routes/workspace/library.tsx")),
});

/** Discover remains an existing destination; this layer only changes routing. */
const discoverRoute = createRoute({
  pendingComponent: ChatLayoutPending,
  errorComponent: ChatLayoutError,
  getParentRoute: () => threadSessionRoute,
  path: "/discover",
  staticData: {
    pageTitle: "sidebar.navDestinations.discover",
    defaultMain: "discover",
    mainView: "discover",
  },
  component: lazyRouteComponent(
    () => import("./routes/workspace/discover.tsx"),
  ),
});

const orgMembersRedirectRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/members",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/settings/members",
      params: { org: params.org },
    });
  },
});

// Org index (`/$org`) resolves to the Super Agent's Home surface — there's no
// bespoke landing page anymore (see org-home). The `main` search param is kept
// so a deep link into a side panel (e.g. "files" = the Library) survives the
// redirect, mirroring the thread's main-panel tabs.
const orgIndexSearchSchema = z.object({
  main: z.union([z.string(), z.literal(0)]).optional(),
  /** LEGACY INPUT ONLY — the retired org resolver carried project identity in
   * search before `/projects/$agentId` became canonical. */
  virtualmcpid: z.string().optional(),
  /** Preserve every route-owned payload until the canonical destination can
   * reclaim it. TanStack validates this hop before OrgHome translates it. */
  ...legacyWorkspaceCompatibilitySearchShape,
  /** Declared so the resolver can forward it: this route sits outside the agent
   *  shell that owns the layout search, and destinations open the chat
   *  collapsed, so `/$org?sidepanel=true` is the only way to land with it open. */
  sidepanel: sidePanelSearchSchema,
  mainpanel: mainPanelSearchSchema,
  thread: z.string().optional(),
});

const orgIndexRoute = createRoute({
  getParentRoute: () => threadRoute,
  path: "/",
  validateSearch: orgIndexSearchSchema,
  pendingComponent: PanelLoading,
  component: lazyRouteComponent(() => import("./layouts/org-home/index.tsx")),
});

/**
 * Short card link (`/$org/t/DECO-01`) — a thin alias now that the card owns
 * `/$org/tasks/DECO-01`, and mounted forever because it is the address every
 * digest email carries (`notifications/digest-email.ts`), delivered ones
 * included.
 *
 * It forwards the key verbatim: the tasks route resolves it, and an unknown
 * one lands on the board there, so this route needs no data of its own.
 */
const taskKeyRoute = createRoute({
  getParentRoute: () => threadRoute,
  path: "/t/$taskKey",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/tasks/{-$taskKey}",
      params: { org: params.org, taskKey: params.taskKey },
      search: (prev: Record<string, unknown>) => prev,
      hash: true,
      replace: true,
    });
  },
});

// ============================================
// SETTINGS ROUTE (/$org/settings)
// ============================================

const settingsRoute = createRoute({
  staticData: { pageTitle: "sidebar.navDestinations.settings" },
  getParentRoute: () => orgRoute,
  path: "/settings",
  /** Panel-area loader, for the same reason as `threadRoute`: the sidebar
   *  belongs to `orgRoute` and stays mounted across this crossing, so a
   *  full-screen `SplashScreen` would blank a shell that is already painted. */
  pendingComponent: PanelLoading,
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/route.tsx"),
  ),
});

// Settings index → redirect to /general
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/index-redirect.tsx"),
  ),
});

// Operations: Connections
const connectionsRoute = createRoute({
  staticData: { pageTitle: "settings.nav.connections" },
  getParentRoute: () => settingsRoute,
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
  staticData: { pageTitle: "settings.nav.connections" },
  getParentRoute: () => settingsRoute,
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
  staticData: { pageTitle: "page.item" },
  getParentRoute: () => settingsRoute,
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
  staticData: { pageTitle: "orgs.monitoring.title" },
  getParentRoute: () => settingsRoute,
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
  staticData: { pageTitle: "settings.nav.general" },
  getParentRoute: () => settingsRoute,
  path: "/general",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/general.tsx"),
  ),
});

const settingsConnectRoute = createRoute({
  staticData: { pageTitle: "settings.nav.connect" },
  getParentRoute: () => settingsRoute,
  path: "/connect",
  pendingComponent: settingsGroupPendingComponent("connect"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/connect.tsx"),
  ),
});

const settingsAiProvidersRoute = createRoute({
  staticData: { pageTitle: "settings.nav.billing" },
  getParentRoute: () => settingsRoute,
  path: "/ai-providers",
  pendingComponent: settingsGroupPendingComponent("billing"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/ai-providers.tsx"),
  ),
});

// Redirects old /settings/billing links to the merged AI Providers page.
const settingsBillingRoute = createRoute({
  staticData: { pageTitle: "settings.nav.billing" },
  getParentRoute: () => settingsRoute,
  path: "/billing",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/settings/ai-providers",
      params: { org: params.org },
    });
  },
});

const settingsInfraBillingRoute = createRoute({
  staticData: { pageTitle: "settings.nav.billing" },
  getParentRoute: () => settingsRoute,
  path: "/infra-billing",
  pendingComponent: settingsGroupPendingComponent("billing"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/infra-billing.tsx"),
  ),
});

const settingsSecretsRoute = createRoute({
  staticData: { pageTitle: "settings.nav.secrets" },
  getParentRoute: () => settingsRoute,
  path: "/secrets",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/secrets.tsx"),
  ),
});

const settingsApiKeysRoute = createRoute({
  staticData: { pageTitle: "settings.nav.connect" },
  getParentRoute: () => settingsRoute,
  path: "/api-keys",
  pendingComponent: settingsGroupPendingComponent("connect"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/api-keys.tsx"),
  ),
});

const settingsBucketsRoute = createRoute({
  staticData: { pageTitle: "settings.nav.storage" },
  getParentRoute: () => settingsRoute,
  path: "/buckets",
  pendingComponent: settingsGroupPendingComponent("storage"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/buckets.tsx"),
  ),
});

const settingsRepositoriesRoute = createRoute({
  staticData: { pageTitle: "settings.nav.repositories" },
  getParentRoute: () => settingsRoute,
  path: "/repositories",
  validateSearch: z.object({
    git_error: z.string().optional().catch(undefined),
    git_flow: z.string().uuid().optional().catch(undefined),
    git_installation: z
      .number()
      .int()
      .positive()
      .safe()
      .optional()
      .catch(undefined),
    git_return: z.boolean().optional().catch(undefined),
  }),
  pendingComponent: settingsGroupPendingComponent("repositories"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/repositories.tsx"),
  ),
});

const settingsSyncedReposRoute = createRoute({
  staticData: { pageTitle: "settings.nav.storage" },
  getParentRoute: () => settingsRoute,
  path: "/synced-repos",
  pendingComponent: settingsGroupPendingComponent("storage"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/synced-repos.tsx"),
  ),
});

const settingsTaskBoardRoute = createRoute({
  staticData: { pageTitle: "settings.nav.tasks" },
  getParentRoute: () => settingsRoute,
  path: "/task-board",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/tasks.tsx"),
  ),
});

// Redirects old /settings/tasks links to the renamed task board settings.
const settingsTasksRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/tasks",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/settings/task-board",
      params: { org: params.org },
    });
  },
});

const settingsMembersRoute = createRoute({
  staticData: { pageTitle: "settings.nav.members" },
  getParentRoute: () => settingsRoute,
  path: "/members",
  pendingComponent: settingsGroupPendingComponent("members"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/members.tsx"),
  ),
});

const settingsRolesRoute = createRoute({
  staticData: { pageTitle: "settings.nav.members" },
  getParentRoute: () => settingsRoute,
  path: "/roles",
  pendingComponent: settingsGroupPendingComponent("members"),
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
  staticData: { pageTitle: "settings.nav.security" },
  getParentRoute: () => settingsRoute,
  path: "/sso",
  component: lazyRouteComponent(() => import("./routes/orgs/settings/sso.tsx")),
});

const settingsProfileRoute = createRoute({
  staticData: { pageTitle: "settings.nav.profile" },
  getParentRoute: () => settingsRoute,
  path: "/profile",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/profile.tsx"),
  ),
});

// ============================================
// UNIFIED CHAT SUB-ROUTES
// ============================================

// Agents list (view all)
const settingsAgentsRoute = createRoute({
  staticData: { pageTitle: "settings.nav.agents" },
  getParentRoute: () => settingsRoute,
  path: "/agents",
  component: lazyRouteComponent(() => import("./routes/agents-list.tsx")),
});

const settingsAutomationsRoute = createRoute({
  staticData: { pageTitle: "settings.nav.automations" },
  getParentRoute: () => settingsRoute,
  path: "/automations",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/automations.tsx"),
  ),
});

const settingsSkillsRoute = createRoute({
  staticData: { pageTitle: "settings.nav.skills" },
  getParentRoute: () => settingsRoute,
  path: "/skills",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/skills.tsx"),
  ),
});

// ============================================
// ROUTE TREE
// ============================================

const settingsWithChildren = settingsRoute.addChildren([
  settingsIndexRoute,
  connectionsRoute,
  connectionDetailRoute,
  collectionDetailRoute,
  settingsAgentsRoute,
  settingsAutomationsRoute,
  settingsSkillsRoute,
  monitoringRoute,
  settingsGeneralRoute,
  settingsConnectRoute,
  settingsAiProvidersRoute,
  settingsBillingRoute,
  settingsInfraBillingRoute,
  settingsSecretsRoute,
  settingsApiKeysRoute,
  settingsBucketsRoute,
  settingsRepositoriesRoute,
  settingsSyncedReposRoute,
  settingsTaskBoardRoute,
  settingsTasksRoute,
  settingsMembersRoute,
  settingsRolesRoute,
  settingsSsoRoute,
  settingsProfileRoute,
]);

const agentSiteEditorWithChildren = agentSiteEditorRoute.addChildren([
  agentSiteEditorIndexRoute,
  agentSiteEditorContentRoute,
  agentSiteEditorCodeRoute,
]);

const agentWorkspaceWithChildren = agentWorkspaceRoute.addChildren([
  agentOverviewRoute,
  projectTasksRoute,
  projectReportsRoute,
  agentSiteEditorWithChildren,
  agentAutomationsRoute,
  agentAutomationRoute,
  agentSettingsRoute,
  agentAssetsRoute,
  agentGitRoute,
  agentHostingRoute,
  agentE2eRoute,
  agentAnalyticsRoute,
  agentExperimentsRoute,
  agentMonitorRoute,
  agentAppRoute,
  agentViewRoute,
  agentOutputFileRoute,
  agentOutputDeckRoute,
  agentLibraryFileRoute,
  agentConnectSourcesRoute,
  agentLegacyProjectViewRoute,
]);

const threadSessionWithChildren = threadSessionRoute.addChildren([
  unifiedChatRoute,
  orgHomeRoute,
  projectsIndexRoute,
  agentWorkspaceWithChildren,
  legacyAgentsIndexRoute,
  legacyAgentsDeepRoute,
  tasksRoute,
  taskBoardAnalyticsRoute,
  threadAnalyticsRoute,
  reportsRoute,
  libraryRoute,
  discoverRoute,
]);

const threadRouteWithChildren = threadRoute.addChildren([
  orgIndexRoute,
  taskKeyRoute,
  threadSessionWithChildren,
]);

const orgRouteWithChildren = orgRoute.addChildren([
  threadRouteWithChildren,
  orgMembersRedirectRoute,
  settingsWithChildren,
]);

const shellRouteTree = shellLayout.addChildren([
  homeRoute,
  orgRouteWithChildren,
]);

const routeTree = rootRoute.addChildren([
  shellRouteTree,
  adminLayoutWithChildren,
  onboardingRoute,
  reportsOnboardingRoute,
  legacyCommerceOnboardingRoute,
  chooseEditorRoute,
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

export const router = createRouter({
  routeTree,
  /** The panel loader is the DEFAULT, and that is the point: a route that names
   *  no `pendingComponent` degrades to a spinner inside the painted shell
   *  instead of blanking the app. TanStack uses this for every match's Suspense
   *  fallback as well as its pending state. No route opts into `SplashScreen`
   *  any more — the splash belongs to the single boundary above the router
   *  (`layouts/boot-gate.tsx`), and a route that named it would mount a second
   *  copy of it. 200ms delay avoids a flash on instant (synchronous) redirects
   *  like the returning-user fast path; 500ms minimum because a loader that
   *  appears for 40ms reads as a glitch. */
  defaultPendingComponent: PanelLoading,
  defaultPendingMs: 200,
  defaultPendingMinMs: 500,
  defaultNotFoundComponent: DefaultNotFoundComponent,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
