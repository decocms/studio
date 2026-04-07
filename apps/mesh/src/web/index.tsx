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

import { authClient } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
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

/**
 * Store invite route - deep links to store apps without knowing the org slug
 * After login, redirects to the user's first org and first registry
 */
const storeInviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/store/$appName",
  component: lazyRouteComponent(() => import("./routes/store-invite.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      serverName: z.string().optional(),
    }),
  ),
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

// Home route (landing, redirects to last or only org)
const homeRoute = createRoute({
  getParentRoute: () => shellLayout,
  path: "/",
  beforeLoad: async () => {
    // Fetch org list once — used for both slug validation and redirect
    const { data: orgs } = await authClient.organization.list();

    // If the list call failed, skip redirect logic to avoid clearing a
    // valid cached slug due to a transient API failure.
    if (!orgs) return;

    // Fast path: validate cached slug against current membership before redirecting.
    // If stale (org deleted or user removed), clear it to prevent a redirect loop.
    const lastOrgSlug = localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    if (lastOrgSlug) {
      const slugIsValid = orgs.some(
        (o: NonNullable<typeof orgs>[number]) => o.slug === lastOrgSlug,
      );
      if (slugIsValid) {
        throw redirect({
          to: "/$org",
          params: { org: lastOrgSlug },
        });
      }
      // Stale — remove so future visits don't loop
      localStorage.removeItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    }

    // Redirect to first available org (every user gets a default org on signup)
    const firstOrg = orgs[0];
    if (firstOrg) {
      throw redirect({
        to: "/$org",
        params: { org: firstOrg.slug },
      });
    }
  },
});

// ============================================
// ORG LAYOUT
// ============================================

const orgLayout = createRoute({
  getParentRoute: () => shellLayout,
  path: "/$org",
  component: lazyRouteComponent(() => import("./layouts/org-layout.tsx")),
});

// ============================================
// ORG-LEVEL ROUTES (children of orgLayout)
// ============================================

// Org home - the default view when entering an org
const orgHomeRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/",
  validateSearch: z.object({
    taskId: z
      .string()
      .optional()
      .transform((v) => v ?? crypto.randomUUID()),
    view: z.string().optional(),
    main: z.string().optional(),
    id: z.string().optional(),
    toolName: z.string().optional(),
    virtualMcpOverride: z.string().optional(),
    tasks: z.number().optional(),
    mainOpen: z.number().optional(),
    chat: z.number().optional(),
  }),
  component: lazyRouteComponent(() => import("./routes/orgs/home/page.tsx")),
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
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/settings/general",
      params: { org: params.org },
    });
  },
  component: () => null,
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

// Organization settings pages
const settingsGeneralRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/general",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/general.tsx"),
  ),
});

const settingsFeaturesRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/features",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/features.tsx"),
  ),
});

const settingsAiProvidersRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/ai-providers",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/ai-providers.tsx"),
  ),
});

const settingsMembersRoute = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/members",
  component: lazyRouteComponent(
    () => import("./routes/orgs/settings/members.tsx"),
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

// Store detail (the store list is part of the connections "All" tab)
const storeDetailRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/store/$appName",
  component: lazyRouteComponent(
    () => import("./routes/orgs/store/mcp-server-detail.tsx"),
  ),
  validateSearch: z.lazy(() =>
    z.object({
      registryId: z.string().optional(),
      serverName: z.string().optional(),
      itemId: z.string().optional(),
    }),
  ),
});

// Org-level plugin route (mirrors /$org/$virtualMcpId/$pluginId for org-admin)
const orgPluginRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/plugins/$pluginId",
  component: lazyRouteComponent(
    () => import("./layouts/org-plugin-layout.tsx"),
  ),
});

// ============================================
// AGENTS (sidebar agents with chat)
// ============================================

// Agents list (view all)
const agentsListRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/agents",
  component: lazyRouteComponent(() => import("./routes/agents-list.tsx")),
});

// Agents layout (/$org/$virtualMcpId)
const agentsLayout = createRoute({
  getParentRoute: () => orgLayout,
  path: "/$virtualMcpId",
  component: Outlet,
});

// Agent home - empty center, sidebar chat is the interaction point
const agentHomeRoute = createRoute({
  getParentRoute: () => agentsLayout,
  path: "/",
  validateSearch: z.object({
    taskId: z
      .string()
      .optional()
      .transform((v) => v ?? crypto.randomUUID()),
    main: z.string().optional(),
    id: z.string().optional(),
    toolName: z.string().optional(),
    virtualMcpOverride: z.string().optional(),
    tasks: z.number().optional(),
    mainOpen: z.number().optional(),
    chat: z.number().optional(),
  }),
  component: lazyRouteComponent(() => import("./routes/agent-home.tsx")),
});

// Agent app view
const agentAppViewRoute = createRoute({
  getParentRoute: () => agentsLayout,
  path: "/apps/$connectionId/$toolName",
  component: lazyRouteComponent(() => import("./routes/project-app-view.tsx")),
});

// Agent workflows
const agentWorkflowsRoute = createRoute({
  getParentRoute: () => agentsLayout,
  path: "/workflows",
  component: lazyRouteComponent(() => import("./routes/orgs/workflow.tsx")),
});

// Agent automations
const agentAutomationsRoute = createRoute({
  getParentRoute: () => agentsLayout,
  path: "/automations",
  validateSearch: z.object({ id: z.string().optional() }),
  component: lazyRouteComponent(
    () => import("./views/automations/agent-automations.tsx"),
  ),
});

// Agent plugin layout
const agentPluginLayoutRoute = createRoute({
  getParentRoute: () => agentsLayout,
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
    parentRoute: agentPluginLayoutRoute as AnyRoute,
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

// Add all plugin routes as children of the agent plugin layout
const agentPluginWithChildren =
  agentPluginLayoutRoute.addChildren(pluginRoutes);

// ============================================
// ROUTE TREE
// ============================================

const settingsWithChildren = settingsLayout.addChildren([
  settingsIndexRoute,
  connectionsRoute,
  connectionDetailRoute,
  collectionDetailRoute,
  monitoringRoute,
  settingsGeneralRoute,
  settingsFeaturesRoute,
  settingsAiProvidersRoute,
  settingsMembersRoute,
  settingsSsoRoute,
  settingsProfileRoute,
  settingsStoreRoute,
  settingsStoreRegistryRoute,
  settingsRegistryRoute,
  settingsWorkflowsRoute,
  settingsWorkflowDetailRoute,
]);

const agentsWithChildren = agentsLayout.addChildren([
  agentHomeRoute,
  agentAppViewRoute,
  agentWorkflowsRoute,
  agentAutomationsRoute,
  agentPluginWithChildren,
]);

const orgRoutes = [
  orgHomeRoute,
  agentsListRoute,
  agentsWithChildren,
  settingsWithChildren,
  storeDetailRoute,
  orgPluginRoute,
];

const orgLayoutWithChildren = orgLayout.addChildren(orgRoutes);

const shellRouteTree = shellLayout.addChildren([
  homeRoute,
  orgLayoutWithChildren,
]);

const routeTree = rootRoute.addChildren([
  shellRouteTree,
  loginRoute,
  resetPasswordRoute,
  betterAuthRoutes,
  oauthCallbackRoute,
  oauthCallbackAiProviderRoute,
  storeInviteRoute,
]);

const router = createRouter({
  routeTree,
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
