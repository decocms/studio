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
  type AnyRoute,
} from "@tanstack/react-router";
import { SplashScreen } from "@/web/components/splash-screen";
import { ChunkErrorBoundary } from "@/web/components/error-boundary";
import * as z from "zod";
import type { ReactNode } from "react";

import "../../index.css";

import { listOrganizationsCached } from "@/web/lib/auth-client";

import { sourcePlugins } from "./plugins.ts";
import type {
  AnyClientPlugin,
  PluginSetupContext,
} from "@decocms/bindings/plugins";

const rootRoute = createRootRoute({
  component: () => (
    <ChunkErrorBoundary>
      <Providers>
        <Suspense fallback={<SplashScreen />}>
          <Outlet />
        </Suspense>
      </Providers>
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
// SHELL LAYOUT (authenticated wrapper)
// ============================================

const shellLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: lazyRouteComponent(() => import("./layouts/shell-layout.tsx")),
});

// Home route (landing) — redesign: you land in your personal space (/me),
// above any org (like chatgpt.com). Entering an Agent from there goes to /$org.
const homeRoute = createRoute({
  getParentRoute: () => shellLayout,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/me" });
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

// Redesign: the USER's personal space (/me) — above any org, like chatgpt.com.
// Standalone full-screen (under rootRoute, no org/ProjectContext needed). Your
// personal agent + your connections + your Agents (entering one → /$org).
const personalHomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/me",
  component: lazyRouteComponent(() => import("./routes/me.tsx")),
});

// ============================================
// ORG LAYOUT
// ============================================

const orgLayout = createRoute({
  getParentRoute: () => shellLayout,
  path: "/$org",
  component: lazyRouteComponent(() => import("./layouts/org-layout.tsx")),
});

// Redesign mock: a standalone onboarding flow at /$org/onboarding (full-screen,
// no shell chrome). Static path → never collides with /$org/$taskId.
const onboardingDemoRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/onboarding",
  component: lazyRouteComponent(() => import("./routes/orgs/onboarding.tsx")),
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
  main: z.string().optional(),
  id: z.string().optional(),
  toolName: z.string().optional(),
  tasks: z.number().optional(),
  mainOpen: z.number().optional(),
  chat: z.number().optional(),
  autosend: z.string().optional(),
  /** Carried from the homepage composer so the new thread's first send
   *  inherits the "Run locally" toggle state. ChatPrefsProvider seeds
   *  runLocally from this on mount. */
  runLocally: z.string().optional(),
});

const unifiedChatRoute = createRoute({
  getParentRoute: () => agentShellLayout,
  path: "/$taskId",
  validateSearch: unifiedChatSearchSchema,
  component: () => null,
});

// Org index renders the home landing page (single-panel + HomePage), no
// agent shell.
const orgIndexRoute = createRoute({
  getParentRoute: () => orgShellLayout,
  path: "/",
  validateSearch: z.lazy(() =>
    z.object({
      // Redesign: when set, the home opens this finding as an incident task in place.
      task: z.string().optional(),
      // Redesign: when "1", the home opens the New Task composer dialog.
      new: z.string().optional(),
    }),
  ),
  component: lazyRouteComponent(() => import("./layouts/org-home/index.tsx")),
});

// Redesign: the Inbox / Findings page (/$org/inbox) — inside the org shell, so
// it has the sidebar + toolbar. Static path, never collides with /$org/$taskId.
const inboxRoute = createRoute({
  getParentRoute: () => orgShellLayout,
  path: "/inbox",
  component: lazyRouteComponent(() => import("./routes/orgs/inbox.tsx")),
});

// Redesign: a live preview of the storefront (/$org/preview) — inside the shell.
const previewRoute = createRoute({
  getParentRoute: () => orgShellLayout,
  path: "/preview",
  component: lazyRouteComponent(() => import("./routes/orgs/preview.tsx")),
});

// Redesign: the storefront content / CMS (/$org/content) — inside the shell.
const contentRoute = createRoute({
  getParentRoute: () => orgShellLayout,
  path: "/content",
  component: lazyRouteComponent(() => import("./routes/orgs/content.tsx")),
});

// Redesign: a goal's closed-loop detail (/$org/goal?g=<id>) — inside the org
// shell. SINGLE static segment + a search param for the id, so it ranks like
// `/inbox` and never collides with the 2-segment `/$taskId/$pluginId` chat route
// (a `/goal/$goalId` path loses that precedence fight and falls through to the
// empty task view).
const goalRoute = createRoute({
  getParentRoute: () => orgShellLayout,
  path: "/goal",
  validateSearch: z.lazy(() => z.object({ g: z.string().optional() })),
  component: lazyRouteComponent(() => import("./routes/orgs/goal.tsx")),
});

// ============================================
// SETTINGS LAYOUT (/$org/settings)
// ============================================

const settingsLayout = createRoute({
  getParentRoute: () => orgLayout,
  path: "/settings",
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
      tab: z.enum(["overview", "audit", "threads"]).default("overview"),
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

// Agent settings overview — the home of everything about one agent
// `?agent` selects which of the user's agents to show (current org by default).
const agentSearchSchema = z.lazy(() =>
  z.object({ agent: z.string().optional() }),
);

const settingsAgentRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/agent",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/agent.tsx"),
  ),
  validateSearch: agentSearchSchema,
});

// Agent personalization — the editable user layer (guidance, skills, connections)
const settingsAgentPersonalizationRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/agent/personalization",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/agent-personalization.tsx"),
  ),
  validateSearch: agentSearchSchema,
});

// Agent automations — Studio automations split System (managed) / Yours
const settingsAgentAutomationsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/agent/automations",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/agent-automations.tsx"),
  ),
  validateSearch: agentSearchSchema,
});

// Agent findings — what the agent watches and how far it acts (agent-wide)
const settingsAgentFindingsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/agent/findings",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/agent-findings.tsx"),
  ),
  validateSearch: agentSearchSchema,
});

// Agent memory — what the agent remembers about you and the work
const settingsAgentMemoryRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/agent/memory",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/agent-memory.tsx"),
  ),
  validateSearch: agentSearchSchema,
});

// Agent files — what the agent reads and what it produces
const settingsAgentFilesRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/agent/files",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/agent-files.tsx"),
  ),
  validateSearch: agentSearchSchema,
});

// Organization settings pages
const settingsGeneralRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/general",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/general.tsx"),
  ),
});

const settingsFindingsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/findings",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/findings.tsx"),
  ),
});

const settingsFeaturesRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/features",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/features.tsx"),
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

const settingsWorkflowsRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/workflows",
  component: lazyRouteComponent(() => import("./routes/orgs/workflow.tsx")),
});

const settingsWorkflowDetailRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/workflows/$itemId",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/workflow-detail.tsx"),
  ),
});

// Org-level plugin route (for org-admin)
const orgPluginRoute = createRoute({
  getParentRoute: () => agentShellLayout,
  path: "/plugins/$pluginId",
  component: lazyRouteComponent(
    () => import("./layouts/org-plugin-layout.tsx"),
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

// Plugin sub-route under unified chat
const unifiedPluginRoute = createRoute({
  getParentRoute: () => unifiedChatRoute,
  path: "/$pluginId",
  component: lazyRouteComponent(
    () => import("./layouts/dynamic-plugin-layout.tsx"),
  ),
});

// ============================================
// PLUGIN ROUTES
// ============================================

// Plugin setup (same as before)
export const pluginRootSidebarItems: {
  pluginId: string;
  icon: ReactNode;
  label: string;
}[] = [];

export const pluginSidebarGroups: {
  pluginId: string;
  id: string;
  label: string;
  items: { icon: ReactNode; label: string }[];
  defaultExpanded?: boolean;
}[] = [];

export const pluginSettingsSidebarItems: {
  pluginId: string;
  key: string;
  icon: ReactNode;
  label: string;
  to: string;
}[] = [];

const pluginRoutes: AnyRoute[] = [];

sourcePlugins.forEach((plugin: AnyClientPlugin) => {
  // Only invoke setup if the plugin provides it
  if (!plugin.setup) return;

  const context: PluginSetupContext = {
    parentRoute: unifiedPluginRoute as AnyRoute,
    routing: {
      createRoute: createRoute,
      lazyRouteComponent: lazyRouteComponent,
    },
    registerRootSidebarItem: (item) =>
      pluginRootSidebarItems.push({ pluginId: plugin.id, ...item }),
    registerSidebarGroup: (group) =>
      pluginSidebarGroups.push({ pluginId: plugin.id, ...group }),
    registerSettingsSidebarItem: (item) =>
      pluginSettingsSidebarItems.push({ pluginId: plugin.id, ...item }),
    registerPluginRoutes: (routes) => {
      pluginRoutes.push(...routes);
    },
  };

  plugin.setup(context);
});

// Add all plugin routes as children of the unified plugin route
const unifiedPluginWithChildren = unifiedPluginRoute.addChildren(pluginRoutes);

// ============================================
// ROUTE TREE
// ============================================

const settingsWithChildren = settingsLayout.addChildren([
  settingsIndexRoute,
  settingsAgentRoute,
  settingsAgentPersonalizationRoute,
  settingsAgentAutomationsRoute,
  settingsAgentFindingsRoute,
  settingsAgentMemoryRoute,
  settingsAgentFilesRoute,
  connectionsRoute,
  connectionDetailRoute,
  collectionDetailRoute,
  settingsAgentsRoute,
  settingsAutomationsRoute,
  monitoringRoute,
  settingsFindingsRoute,
  settingsGeneralRoute,
  settingsFeaturesRoute,
  settingsBrandContextRoute,
  settingsAiProvidersRoute,
  settingsSecretsRoute,
  settingsFilesRoute,
  settingsMembersRoute,
  settingsRolesRoute,
  settingsSsoRoute,
  settingsProfileRoute,
  settingsStoreRoute,
  settingsStoreRegistryRoute,
  settingsRegistryRoute,
  settingsWorkflowsRoute,
  settingsWorkflowDetailRoute,
]);

const unifiedChatWithChildren = unifiedChatRoute.addChildren([
  unifiedPluginWithChildren,
]);

const agentShellWithChildren = agentShellLayout.addChildren([
  unifiedChatWithChildren,
  orgPluginRoute,
]);

const orgShellWithChildren = orgShellLayout.addChildren([
  orgIndexRoute,
  inboxRoute,
  previewRoute,
  contentRoute,
  goalRoute,
  agentShellWithChildren,
]);

const orgLayoutWithChildren = orgLayout.addChildren([
  orgShellWithChildren,
  settingsWithChildren,
  onboardingDemoRoute,
]);

const shellRouteTree = shellLayout.addChildren([
  homeRoute,
  orgLayoutWithChildren,
]);

const routeTree = rootRoute.addChildren([
  shellRouteTree,
  onboardingRoute,
  personalHomeRoute,
  loginRoute,
  cliAuthSuccessRoute,
  resetPasswordRoute,
  betterAuthRoutes,
  oauthCallbackRoute,
  oauthCallbackAiProviderRoute,
]);

const router = createRouter({
  routeTree,
  // Show the splash (not a blank screen) while a route loader/beforeLoad is
  // awaiting — e.g. the new-user org-list fetch. 200ms delay avoids a flash on
  // instant (synchronous) redirects like the returning-user fast path.
  defaultPendingComponent: SplashScreen,
  defaultPendingMs: 200,
  defaultNotFoundComponent: () => (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-4 p-8">
        <h3 className="text-lg font-medium text-foreground">Page not found</h3>
        <p className="text-sm text-muted-foreground text-center max-w-[300px]">
          The page you are looking for does not exist or has been moved.
        </p>
        <button
          type="button"
          onClick={() => window.history.back()}
          className="text-sm text-primary hover:underline"
        >
          Go back
        </button>
      </div>
    </div>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root")!;

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
