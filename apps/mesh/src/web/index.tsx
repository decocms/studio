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
  component: lazyRouteComponent(() => import("./routes/home.tsx")),
  beforeLoad: async () => {
    // Fetch org list once — used for both slug validation and single-org redirect
    const { data: orgs } = await authClient.organization.list();

    // If the list call failed, skip all redirect logic to avoid clearing a
    // valid cached slug due to a transient API failure.
    if (!orgs) return;

    // Fast path: validate cached slug against current membership before redirecting.
    // If stale (org deleted or user removed), clear it to prevent a redirect loop
    // where an invalid slug → shell fails → back to "/" → same redirect → loop.
    const lastOrgSlug = localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    if (lastOrgSlug) {
      const slugIsValid = orgs.some((o) => o.slug === lastOrgSlug);
      if (slugIsValid) {
        throw redirect({
          to: "/$org",
          params: { org: lastOrgSlug },
        });
      }
      // Stale — remove so future visits don't loop
      localStorage.removeItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    }

    // Slow path: first-time user — redirect if they only have one org
    const onlyOrg = orgs.length === 1 ? orgs[0] : undefined;
    if (onlyOrg) {
      throw redirect({
        to: "/$org",
        params: { org: onlyOrg.slug },
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
  validateSearch: z.object({
    settings: z.string().optional(),
  }),
});

// ============================================
// ORG-LEVEL ROUTES (children of orgLayout)
// ============================================

// Org home - the default view when entering an org
const orgHomeRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/",
  component: lazyRouteComponent(() => import("./routes/orgs/home/page.tsx")),
});

// Tasks
const tasksRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/tasks",
  component: lazyRouteComponent(() => import("./routes/tasks.tsx")),
});

// Projects list
const projectsListRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/projects",
  component: lazyRouteComponent(() => import("./routes/projects-list.tsx")),
});

// Members
const membersRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/members",
  component: lazyRouteComponent(() => import("./routes/orgs/members.tsx")),
});

// Connections (mcps)
const connectionsRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/mcps",
  component: lazyRouteComponent(() => import("./routes/orgs/connections.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      action: z.enum(["create"]).optional(),
      tab: z.enum(["all", "connected"]).optional(),
    }),
  ),
});

// Connection detail
const connectionDetailRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/mcps/$appSlug",
  component: lazyRouteComponent(
    () => import("./routes/orgs/connection-detail.tsx"),
  ),
  validateSearch: z.lazy(() =>
    z.object({
      tab: z.string().optional(),
    }),
  ),
});

// Collection detail
const collectionDetailRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/mcps/$appSlug/$collectionName/$itemId",
  component: lazyRouteComponent(
    () => import("./routes/orgs/collection-detail.tsx"),
  ),
  validateSearch: z.lazy(() =>
    z.object({
      replayId: z.string().optional(), // Random ID to lookup input in sessionStorage
    }),
  ),
});

// Monitoring
const monitoringRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/monitoring",
  component: lazyRouteComponent(() => import("./routes/orgs/monitoring.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      tab: z.enum(["overview", "audit", "dashboards"]).default("overview"),
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

// Dashboard view
const dashboardViewRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/monitoring/dashboards/$dashboardId",
  component: lazyRouteComponent(
    () => import("./routes/orgs/monitoring-dashboard-view.tsx"),
  ),
});

// Dashboard edit
const dashboardEditRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/monitoring/dashboards/$dashboardId/edit",
  component: lazyRouteComponent(
    () => import("./routes/orgs/monitoring-dashboard-edit.tsx"),
  ),
});

// Store
const storeRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/store",
  component: lazyRouteComponent(() => import("./routes/orgs/store/page.tsx")),
});

const storeDetailRoute = createRoute({
  getParentRoute: () => storeRoute,
  path: "/$appName",
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

// Automations
const automationsRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/automations",
  component: lazyRouteComponent(() => import("./routes/orgs/automations.tsx")),
});

const automationDetailRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/automations/$automationId",
  component: lazyRouteComponent(
    () => import("./routes/orgs/automation-detail.tsx"),
  ),
  validateSearch: z.lazy(() =>
    z.object({
      tab: z.string().optional(),
    }),
  ),
});

// Agents
const agentsRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/agents",
  component: lazyRouteComponent(() => import("./routes/orgs/agents.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      action: z.enum(["create"]).optional(),
    }),
  ),
});

const agentDetailRoute = createRoute({
  getParentRoute: () => orgLayout,
  path: "/agents/$agentId",
  component: lazyRouteComponent(() => import("./routes/orgs/agent-detail.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      tab: z.string().optional(),
    }),
  ),
});

// ============================================
// VIRTUAL MCP LAYOUT (/$org/projects/$virtualMcpId)
// ============================================

const virtualMcpLayout = createRoute({
  getParentRoute: () => orgLayout,
  path: "/projects/$virtualMcpId",
  component: lazyRouteComponent(
    () => import("./layouts/virtual-mcp-layout.tsx"),
  ),
  validateSearch: z.object({
    settings: z.string().optional(),
  }),
});

// ============================================
// VIRTUAL MCP ROUTES (children of virtualMcpLayout)
// ============================================

// Project home - chat view (same as org home)
const projectHomeRoute = createRoute({
  getParentRoute: () => virtualMcpLayout,
  path: "/",
  component: lazyRouteComponent(() => import("./routes/orgs/home/page.tsx")),
});

// Project tasks
const projectTasksRoute = createRoute({
  getParentRoute: () => virtualMcpLayout,
  path: "/tasks",
  component: lazyRouteComponent(() => import("./routes/tasks.tsx")),
});

// Project settings — layout for /$org/projects/$virtualMcpId/settings/*
const projectSettingsRoute = createRoute({
  getParentRoute: () => virtualMcpLayout,
  path: "/settings",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/layout.tsx"),
  ),
});

const projectSettingsDirectIndexRoute = createRoute({
  getParentRoute: () => projectSettingsRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/projects/$virtualMcpId/settings/general",
      params: {
        org: params.org,
        virtualMcpId: (params as Record<string, string>).virtualMcpId,
      },
    });
  },
  component: () => null,
});

const projectSettingsDirectGeneralRoute = createRoute({
  getParentRoute: () => projectSettingsRoute,
  path: "/general",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/general.tsx"),
  ),
});

const projectSettingsDirectDependenciesRoute = createRoute({
  getParentRoute: () => projectSettingsRoute,
  path: "/dependencies",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/dependencies.tsx"),
  ),
});

const projectSettingsDirectSidebarRoute = createRoute({
  getParentRoute: () => projectSettingsRoute,
  path: "/sidebar",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/sidebar-settings.tsx"),
  ),
});

const projectSettingsDirectPluginsRoute = createRoute({
  getParentRoute: () => projectSettingsRoute,
  path: "/plugins",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/plugins.tsx"),
  ),
});

const projectSettingsDirectDangerRoute = createRoute({
  getParentRoute: () => projectSettingsRoute,
  path: "/danger",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/danger.tsx"),
  ),
});

// Pinned App View (virtual MCP scoped)
const projectAppViewRoute = createRoute({
  getParentRoute: () => virtualMcpLayout,
  path: "/apps/$connectionId/$toolName",
  component: lazyRouteComponent(() => import("./routes/project-app-view.tsx")),
});

// Workflows (virtual MCP scoped)
const workflowsRoute = createRoute({
  getParentRoute: () => virtualMcpLayout,
  path: "/workflows",
  component: lazyRouteComponent(() => import("./routes/orgs/workflow.tsx")),
});

// ============================================
// PLUGIN ROUTES
// ============================================

const pluginLayoutRoute = createRoute({
  getParentRoute: () => virtualMcpLayout,
  path: "/$pluginId",
  component: lazyRouteComponent(
    () => import("./layouts/dynamic-plugin-layout.tsx"),
  ),
});

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

const pluginRoutes: AnyRoute[] = [];

sourcePlugins.forEach((plugin: AnyClientPlugin) => {
  // Only invoke setup if the plugin provides it
  if (!plugin.setup) return;

  const context: PluginSetupContext = {
    parentRoute: pluginLayoutRoute as AnyRoute,
    routing: {
      createRoute: createRoute,
      lazyRouteComponent: lazyRouteComponent,
    },
    registerRootSidebarItem: (item) =>
      pluginRootSidebarItems.push({ pluginId: plugin.id, ...item }),
    registerSidebarGroup: (group) =>
      pluginSidebarGroups.push({ pluginId: plugin.id, ...group }),
    registerPluginRoutes: (routes) => {
      pluginRoutes.push(...routes);
    },
  };

  plugin.setup(context);
});

// Add all plugin routes as children of the plugin layout
const pluginLayoutWithChildren = pluginLayoutRoute.addChildren(pluginRoutes);

// ============================================
// ROUTE TREE
// ============================================

const storeRouteWithChildren = storeRoute.addChildren([storeDetailRoute]);

const projectSettingsDirectWithChildren = projectSettingsRoute.addChildren([
  projectSettingsDirectIndexRoute,
  projectSettingsDirectGeneralRoute,
  projectSettingsDirectDependenciesRoute,
  projectSettingsDirectSidebarRoute,
  projectSettingsDirectPluginsRoute,
  projectSettingsDirectDangerRoute,
]);

const virtualMcpWithChildren = virtualMcpLayout.addChildren([
  projectHomeRoute,
  projectTasksRoute,
  projectSettingsDirectWithChildren,
  projectAppViewRoute,
  workflowsRoute,
  pluginLayoutWithChildren,
]);

const orgRoutes = [
  orgHomeRoute,
  tasksRoute,
  projectsListRoute,
  membersRoute,
  connectionsRoute,
  connectionDetailRoute,
  collectionDetailRoute,
  monitoringRoute,
  dashboardViewRoute,
  dashboardEditRoute,
  storeRouteWithChildren,
  automationsRoute,
  automationDetailRoute,
  agentsRoute,
  agentDetailRoute,
  virtualMcpWithChildren,
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
