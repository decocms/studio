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
import { promoteLegacyTaskParam } from "@/lib/legacy-route-translation";
import { isKnownPanelSegment } from "@/layouts/main-panel-tabs/panel-route";

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

const adminLayoutWithChildren = adminLayout.addChildren([
  adminIndexRoute,
  adminUsersRoute,
  adminOrgsRoute,
  adminPromptsRoute,
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
  /** The last route above the sidebar, and the one that mounts it. `boot-gate.tsx`
   *  resolves this match before the router mounts, so it shows no loader during
   *  boot; after boot `beforeLoad` is synchronous and the chunk is cached, so an
   *  org switch resolves it well inside `defaultPendingMs`. Keep it that way —
   *  an async loader here, or anything under `OrgLayout` that suspends, would
   *  put a loading state back on top of a painted shell. */
  component: lazyRouteComponent(() => import("./layouts/org-layout.tsx")),
});

// ============================================
// ORG SHELL LAYOUT (pathless — sidebar + Toolbar + ChatPrefsProvider for / and /$taskId)
// ============================================

const orgShellLayout = createRoute({
  getParentRoute: () => orgLayout,
  id: "org-shell",
  /** The panel-area loader, NOT the app-wide `SplashScreen`. The sidebar is
   *  `orgLayout`'s now, so this route's pending state covers only the inset —
   *  without this, returning from the settings tree blanked the whole viewport
   *  for as long as this chunk and its providers took, which is the same reason
   *  `agentShellLayout` below sets it. */
  pendingComponent: PanelLoading,
  component: lazyRouteComponent(
    () => import("./layouts/org-shell-layout/index.tsx"),
  ),
});

// ============================================
// AGENT SHELL LAYOUT (pathless — per-task chrome under orgShellLayout)
// ============================================

/**
 * Layout search, declared ONCE for every route under the agent shell.
 *
 * Path = which page. Search = how that page is laid out. `sidepanel`,
 * `mainpanel` and `thread` describe the layout, never the page, so they live
 * here on the pathless parent and no destination route re-declares them. The
 * two panel params are symmetric booleans — is this panel open — and WHICH view
 * the main panel shows is the agents route's `{-$panel}` segment, not search.
 */
const workspaceLayoutSearchSchema = z.object({
  /** Whether the chat side panel is open. Absent = the route/agent default,
   *  which is closed on any destination that declares a `defaultMain`. Legacy
   *  `chat`/`0` links parse to the same boolean (see `panel-search.ts`). */
  sidepanel: sidePanelSearchSchema,
  /** Whether the main panel is open. Absent = open whenever the URL names a
   *  view (path segment, route default, then the agent's own default). */
  mainpanel: mainPanelSearchSchema,
  /** LEGACY INPUT ONLY — the view is a path segment and its visibility is
   *  `mainpanel` now. Still arrives from bookmarks and from already-delivered
   *  mail (`tools/reports/setup.ts`, `commerce-diagnostic-share.ts`), so it is
   *  accepted here and retired by `<LegacyMainRedirect />`. Nothing writes it. */
  main: z.union([z.string(), z.literal(0)]).optional(),
  /** The open thread on a destination route. The legacy `/$org/$taskId` carries
   *  the same id in its path param instead, so nothing reads both. */
  thread: z.string().optional(),
  /** The active project SCOPE — a filter, never a container. Declared here so
   *  every destination inherits it and retained below so it survives
   *  navigation; which routes RESOLVE it is answered once, in
   *  `resolveRouteAgentId`. Only the sidebar picker writes it, never
   *  automatically. See `hooks/use-project-scope.ts`. */
  virtualmcpid: z.string().optional(),
});

const agentShellLayout = createRoute({
  getParentRoute: () => orgShellLayout,
  id: "agent-shell",
  validateSearch: workspaceLayoutSearchSchema,
  /** `sidepanel` and `virtualmcpid` follow you across the workspace; both
   *  describe the workspace rather than one page. NOT `main` (per-destination,
   *  via `staticData.defaultMain`) and NOT `thread` (belongs to one project).
   *
   *  Retention re-adds a key only when the next search OMITS it, so anything
   *  that must DROP the scope has to write `virtualmcpid: undefined`
   *  explicitly — deleting the key just invites it straight back. */
  search: { middlewares: [retainSearchParams(["sidepanel", "virtualmcpid"])] },
  // Render the centered panel-area loader (matches the shell's own Suspense
  // fallbacks) while this route loads, instead of the full-screen SplashScreen.
  // The sidebar is already mounted by orgShellLayout, so the pending state
  // covers only the main panel region — no off-center left flash on nav.
  pendingComponent: PanelLoading,
  component: lazyRouteComponent(
    () => import("./layouts/agent-shell-layout/index.tsx"),
  ),
});

// ============================================
// UNIFIED CHAT ROUTES (/$org/$taskId)
// ============================================

const unifiedChatSearchSchema = z.object({
  virtualmcpid: z.string().optional(),
  /** Open the Library file-preview overlay over the chat (browse-grammar path
   *  "<volume>/<path…>"). Set by clickable org-file refs in agent messages. */
  preview: z.string().optional(),
  /** Deep-links a task board card's modal open inside the `main=board`
   *  overlay. */
  task: z.string().optional(),
  autosend: z.string().optional(),
  /** Commerce onboarding hand-off: `"1"` mounts the blocking connections modal
   *  over this report route until at least one data source is connected. Dropped
   *  by the modal once the enriching run is triggered. */
  connect: z.coerce.string().optional(),
  /** Commerce onboarding hand-off: the claimed site the connect modal is for,
   *  carried in the URL (same context as `/commerce-onboarding?siteUrl=…`) so the
   *  modal is self-describing. Falls back to the connection's stored metadata. */
  siteUrl: z.string().optional(),
  /** Storefront "." deep-link: preselect a page in the content editor. Set by
   *  `/choose-editor`; consumed by ContentBrowser. `contentPageId` is the CMS
   *  page id; `contentPath`/`contentPathTemplate` are the concrete URL and its
   *  route template (page.path in the decofile stores the template). */
  contentPageId: z.string().optional(),
  contentPath: z.string().optional(),
  contentPathTemplate: z.string().optional(),
  /** Task board view state (`main=board`) — persisted in the URL so a refresh
   *  or a shared link keeps the layout and filters. See `filters-search.ts`. */
  view: z.string().optional(),
  q: z.string().optional(),
  assignee: z.string().optional(),
  priority: z.string().optional(),
  due: z.string().optional(),
  tags: z.string().optional(),
  repo: z.string().optional(),
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

/**
 * DESTINATION ROUTES (`/$org/home`, `/agents`, `/tasks`, `/reports`, `/library`)
 *
 * ROUTE GRAMMAR — path = which page, search = how that page is laid out.
 *
 * A destination (Home, Agents, Tasks, Reports, Library) is a real path segment,
 * and so is the per-agent view the main panel shows — preview, code, content,
 * assets, git, settings, automations are `{-$panel}` on the agents route. Layout
 * is not: `sidepanel`, `mainpanel` and `thread` are declared once on
 * `agentShellLayout` and inherited by every destination below. That split is
 * what freed the view from search: `mainpanel` carries the visibility `main=0`
 * used to mean, so the path can carry the view alone. Only the extras a single
 * destination reads (board filters, the library path, the panel's own
 * parameter, the commerce hand-off) are declared on it.
 *
 * An optional segment (`{-$panel}` on agents, `{-$taskKey}` on tasks) is ONE
 * path param, not a pair of sibling routes: the param is `string | undefined`
 * and the segment simply vanishes when absent. The project is NOT a segment: it
 * is `?virtualmcpid=`, carrying the raw virtual-MCP id (`vir_*`, plus the
 * synthetic `decopilot_<orgId>` and `<orgId>_commerce-discovery`) — there is no
 * slug and no new schema — because it has to mean the same thing on `/tasks`
 * and `/library`, which have no segment to hold it. A bare `/$org/agents` with
 * no scope means "all projects", for everyone: a sidebar link may be scoped, a
 * typed URL never is. A bare `/$org/tasks` is the lanes.
 *
 * These routes sit under `agentShellLayout`, which renders no `<Outlet />` —
 * the page itself comes from the main-panel machinery, keyed on the resolved
 * `?main` tab. So a destination's whole job is to own its path, own its own
 * search extras, and declare its default `?main` via `staticData.defaultMain`
 * (see `useRouteDefaultMain`); an explicit `?main=` always wins over it. Their
 * components are therefore `() => null` — giving one a real component would
 * silently render nothing.
 *
 * RANKING INVARIANT: TanStack ranks statics above dynamics above optionals at
 * the same position, so `/$org/home`, `/$org/agents` and `/$org/tasks` beat the
 * `/$org/$taskId` sibling exactly as `/$org/settings` already does. But
 * `sortDynamic` returns 0 for two SAME-SHAPE dynamic siblings under one node,
 * and the winner then silently becomes registration order — so never register a
 * second `/$org/$something`.
 *
 * These destinations are unconditional: the sidebar links straight to them
 * and `/$org` resolves into them. There is no flag and no alternate chrome.
 */

/** Home — the org's, or a scoped agent's. `staticData.defaultMain` sits above
 *  the agent's own `defaultMainView`, so this one id has to serve both; which
 *  face it wears is the SCOPE's answer, given in `HomeTab`. */
const orgHomeRoute = createRoute({
  getParentRoute: () => agentShellLayout,
  path: "/home",
  staticData: { defaultMain: "overview" },
  validateSearch: z.object({
    /** Commerce onboarding hand-off, forwarded verbatim by the `/$org` resolver. */
    connect: z.coerce.string().optional(),
    siteUrl: z.string().optional(),
  }),
  component: () => null,
});

/** The agent workspace, and the view its main panel is showing. `{-$panel}` is
 *  the view (`/agents/preview?virtualmcpid=vir_x`); payload-carrying kinds put the
 *  KIND in the segment and the payload in the search below — a grammar
 *  `main-panel-tabs/panel-route.ts` owns both directions of. The project is
 *  `?virtualmcpid=`, NOT a segment: it has to mean the same thing on `/tasks` and
 *  `/library`, which have no segment to hold it. One carrier, one meaning; no
 *  project = the Super Agent. One optional segment removes the old
 *  `/agents/preview` ambiguity from the ROUTER but not from the grammar — a
 *  bookmarked `/agents/vir_x` is still told apart from a view name, which
 *  `beforeLoad` does below. */
const agentsRoute = createRoute({
  getParentRoute: () => agentShellLayout,
  path: "/agents/{-$panel}",
  /**
   * A lone segment that is NOT a known view is a project id from a bookmark or
   * a link minted before the project moved to search. Move it and re-enter.
   *
   * `panel: undefined` is not optional: params MERGE with the current match, so
   * without it the redirect target keeps `panel: "vir_x"`, re-matches this
   * route, and `beforeLoad` fires forever — router-core has no redirect-count
   * guard. `search: (prev) => …` and `hash: true` are likewise load-bearing:
   * a `redirect` with no `search` key returns `{}` and silently drops the
   * panel's payload (`connection`/`tool`), landing the report CTA on an empty
   * app view with no error.
   */
  beforeLoad: ({ params, search }) => {
    const segment = params.panel;
    if (!segment || isKnownPanelSegment(segment)) return;
    if ((search as { virtualmcpid?: string }).virtualmcpid) return;
    throw redirect({
      to: "/$org/agents/{-$panel}",
      params: { org: params.org, panel: undefined },
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        virtualmcpid: segment,
      }),
      hash: true,
      replace: true,
    });
  },
  validateSearch: z.object({
    /** The active panel's parameter — at most one kind's keys are ever set. */
    file: z.string().optional(),
    key: z.string().optional(),
    deck: z.string().optional(),
    path: z.string().optional(),
    connection: z.string().optional(),
    tool: z.string().optional(),
    automation: z.string().optional(),
    /** Library file-preview overlay ("<volume>/<path…>"), set by org-file refs. */
    preview: z.string().optional(),
    autosend: z.string().optional(),
    /** Commerce onboarding hand-off (see `/$org/reports`). */
    connect: z.coerce.string().optional(),
    siteUrl: z.string().optional(),
    /** Storefront "." deep-link: preselect a page in the content editor. */
    contentPageId: z.string().optional(),
    contentPath: z.string().optional(),
    contentPathTemplate: z.string().optional(),
  }),
  component: () => null,
});

/** `/$org/agents/<project>/<panel>` — the shape from before the project moved
 *  to search, when the route was briefly `/projects`. MOUNTED FOREVER, and not for
 *  ordinary back-compat: `COMMERCE_DISCOVERY_SETUP` POSTs the report CTA to the
 *  commerce-discovery service, which PERSISTS it per (org, site) and re-sends it
 *  on every run, refreshing only when setup runs again — for a dormant org,
 *  never. That URL lives in a database we do not own, and share invites carry
 *  the same shape in mail we cannot recall. Two REQUIRED segments, so it never
 *  competes with the optional-segment route above; `search`/`hash` are forwarded
 *  explicitly because a bare `redirect` drops both. */
const agentsLegacyProjectRoute = createRoute({
  getParentRoute: () => agentShellLayout,
  path: "/agents/$project/$panel",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/agents/{-$panel}",
      params: { org: params.org, panel: params.panel },
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        virtualmcpid: params.project,
      }),
      hash: true,
      replace: true,
    });
  },
});

/**
 * Task board, and the card a URL opens.
 *
 * `{-$taskKey}` is the card's own address, written as the human key it already
 * shows (`DECO-01`, or a synced card's `EX-333` — see `task-route.ts`); no
 * segment is the lanes. The board's filters stay in search because a filter is
 * how this page is laid out, whereas a card is a thing you open.
 *
 * The segment took the slot the never-reachable `{-$project}` held. Project
 * scoping is `?virtualmcpid=` instead — the shape a board-wide filter has, and
 * the same key every other destination reads it from.
 */
const tasksRoute = createRoute({
  getParentRoute: () => agentShellLayout,
  path: "/tasks/{-$taskKey}",
  staticData: { defaultMain: "board" },
  validateSearch: z.object({
    /** LEGACY INPUT ONLY — the card is a path segment now. Still arrives from
     *  the `/$org` resolver and from `/$org/$taskId`; `beforeLoad` rewrites it
     *  to the path form. Nothing writes it. */
    task: z.string().optional(),
    /** Board view state, persisted in the URL. See `filters-search.ts`. */
    view: z.string().optional(),
    q: z.string().optional(),
    assignee: z.string().optional(),
    priority: z.string().optional(),
    due: z.string().optional(),
    tags: z.string().optional(),
    repo: z.string().optional(),
  }),
  beforeLoad: ({ params, search }) => {
    const promoted = promoteLegacyTaskParam(params.taskKey, search);
    if (!promoted) return;
    throw redirect({
      to: "/$org/tasks/{-$taskKey}",
      params: { org: params.org, taskKey: promoted.taskKey },
      search: promoted.search,
      replace: true,
    });
  },
  component: () => null,
});

/** The org's Commerce Discovery report. Org-wide, so no project segment. */
const reportsRoute = createRoute({
  getParentRoute: () => agentShellLayout,
  path: "/reports",
  staticData: { defaultMain: "reports" },
  validateSearch: z.object({
    /** `"1"` mounts the blocking connections modal until a data source is
     *  connected; `siteUrl` is the claimed site it is for. */
    connect: z.coerce.string().optional(),
    siteUrl: z.string().optional(),
  }),
  component: () => null,
});

/** Library. Org-wide, so no project segment. */
const libraryRoute = createRoute({
  getParentRoute: () => agentShellLayout,
  path: "/library",
  staticData: { defaultMain: "files" },
  validateSearch: z.object({
    path: z.string().optional(),
    preview: z.string().optional(),
    skill: z.string().optional(),
    brand: z.string().optional(),
  }),
  component: () => null,
});

/**
 * Discover — the permanent, linkable home for what this org does NOT have yet:
 * unfinished setup, capabilities not turned on, and the app catalog.
 *
 * It exists so a destination never has to be hidden to keep the sidebar honest.
 * Hiding Reports until an org owned a diagnostic shipped once and was reverted,
 * because it removed the only in-product way to ask for one (see
 * `main-panel-tabs/reports-tab.tsx`). Withholding a shortcut must never
 * withhold the purchase — so anything withheld is named here instead.
 *
 * Org-wide by definition: what you don't have isn't a property of one project.
 */
const discoverRoute = createRoute({
  getParentRoute: () => agentShellLayout,
  path: "/discover",
  staticData: { defaultMain: "discover" },
  component: () => null,
});

/**
 * `/$org/members` — the Stripe return-URL shape. `orgSettingsPath` emits
 * `/$org/settings/members`, so this only has to keep the shorter link alive.
 */
const orgMembersRedirectRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/members",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/settings/members",
      params: { org: params.org },
    });
  },
});

// Org index (`/$org`) resolves to the Super Agent's home thread — there's no
// bespoke landing page anymore (see org-home). The `main` search param is kept
// so a deep link into a side panel (e.g. "files" = the Library) survives the
// redirect, mirroring the thread's main-panel tabs.
const orgIndexSearchSchema = z.object({
  main: z.string().optional(),
  connect: z.coerce.string().optional(),
  siteUrl: z.string().optional(),
  /** LEGACY INPUT ONLY — a card to open, forwarded verbatim onto `/$org/tasks`,
   *  which retires it into its path segment. Without it here a shared
   *  `/$org?main=board&task=…` would drop the card on the redirect. */
  task: z.string().optional(),
  /** Declared so the resolver can forward it: this route sits outside the agent
   *  shell that owns the layout search, and destinations open the chat
   *  collapsed, so `/$org?sidepanel=true` is the only way to land with it open. */
  sidepanel: sidePanelSearchSchema,
});

const orgIndexRoute = createRoute({
  getParentRoute: () => orgShellLayout,
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
  getParentRoute: () => orgShellLayout,
  path: "/t/$taskKey",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/tasks/{-$taskKey}",
      params: { org: params.org, taskKey: params.taskKey },
      replace: true,
    });
  },
});

// ============================================
// SETTINGS LAYOUT (/$org/settings)
// ============================================

const settingsLayout = createRoute({
  getParentRoute: () => orgLayout,
  path: "/settings",
  /** Panel-area loader, for the same reason as `orgShellLayout`: the sidebar
   *  belongs to `orgLayout` and stays mounted across this crossing, so a
   *  full-screen `SplashScreen` would blank a shell that is already painted. */
  pendingComponent: PanelLoading,
  component: lazyRouteComponent(() => import("./layouts/settings-layout.tsx")),
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
  pendingComponent: settingsGroupPendingComponent("connect"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/connect.tsx"),
  ),
});

const settingsAiProvidersRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/ai-providers",
  pendingComponent: settingsGroupPendingComponent("billing"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/ai-providers.tsx"),
  ),
});

// Redirects old /settings/billing links to the merged AI Providers page.
const settingsBillingRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/billing",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/settings/ai-providers",
      params: { org: params.org },
    });
  },
});

const settingsInfraBillingRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/infra-billing",
  pendingComponent: settingsGroupPendingComponent("billing"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/infra-billing.tsx"),
  ),
});

const settingsSecretsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/secrets",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/secrets.tsx"),
  ),
});

const settingsApiKeysRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/api-keys",
  pendingComponent: settingsGroupPendingComponent("connect"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/api-keys.tsx"),
  ),
});

const settingsBucketsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/buckets",
  pendingComponent: settingsGroupPendingComponent("storage"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/buckets.tsx"),
  ),
});

const settingsRepositoriesRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/repositories",
  pendingComponent: settingsGroupPendingComponent("storage"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/repositories.tsx"),
  ),
});

const settingsSyncedReposRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/synced-repos",
  pendingComponent: settingsGroupPendingComponent("storage"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/synced-repos.tsx"),
  ),
});

const settingsTaskBoardRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/task-board",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/tasks.tsx"),
  ),
});

// Redirects old /settings/tasks links to the renamed task board settings.
const settingsTasksRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/tasks",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/settings/task-board",
      params: { org: params.org },
    });
  },
});

const settingsMembersRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/members",
  pendingComponent: settingsGroupPendingComponent("members"),
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/members.tsx"),
  ),
});

const settingsRolesRoute = createRoute({
  getParentRoute: () => settingsLayout,
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

const settingsSkillsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/skills",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/skills.tsx"),
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
  settingsStoreRoute,
  settingsStoreRegistryRoute,
  settingsRegistryRoute,
]);

const agentShellWithChildren = agentShellLayout.addChildren([
  unifiedChatRoute,
  orgHomeRoute,
  agentsRoute,
  agentsLegacyProjectRoute,
  tasksRoute,
  reportsRoute,
  libraryRoute,
  discoverRoute,
]);

const orgShellWithChildren = orgShellLayout.addChildren([
  orgIndexRoute,
  taskKeyRoute,
  agentShellWithChildren,
]);

const orgLayoutWithChildren = orgLayout.addChildren([
  orgShellWithChildren,
  orgMembersRedirectRoute,
  settingsWithChildren,
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
