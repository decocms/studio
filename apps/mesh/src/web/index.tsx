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
import * as z from "zod";
import type { ReactNode } from "react";

import "../../index.css";

import { sourcePlugins } from "./plugins.ts";
import type {
  AnyClientPlugin,
  PluginSetupContext,
} from "@decocms/bindings/plugins";
import { ORG_ADMIN_PROJECT_SLUG } from "@decocms/mesh-sdk";

const rootRoute = createRootRoute({
  component: () => (
    <Providers>
      <Suspense fallback={<SplashScreen />}>
        <Outlet />
      </Suspense>
    </Providers>
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
 * Gateway templates connect flow (public, no auth)
 */
const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect/$sessionId",
  component: lazyRouteComponent(() => import("./routes/connect.tsx")),
});

/**
 * Storefront diagnostic onboarding (public, no auth)
 */
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: lazyRouteComponent(() => import("./routes/onboarding.tsx")),
});

/**
 * Diagnostic report view (public, no auth)
 */
const reportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/report/$token",
  component: lazyRouteComponent(() => import("./routes/report.tsx")),
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

// ============================================
// SHELL LAYOUT (authenticated wrapper)
// ============================================

const shellLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: lazyRouteComponent(() => import("./layouts/shell-layout.tsx")),
});

// Home route (landing, redirects to first org)
const homeRoute = createRoute({
  getParentRoute: () => shellLayout,
  path: "/",
  component: lazyRouteComponent(() => import("./routes/home.tsx")),
});

// ============================================
// ORG REDIRECT ROUTE
// ============================================

// Redirects /$org to /$org/org-admin
const orgRedirectRoute = createRoute({
  getParentRoute: () => shellLayout,
  path: "/$org",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/$project",
      params: { org: params.org, project: ORG_ADMIN_PROJECT_SLUG },
    });
  },
});

// ============================================
// PROJECT LAYOUT
// ============================================

const projectLayout = createRoute({
  getParentRoute: () => shellLayout,
  path: "/$org/$project",
  component: lazyRouteComponent(() => import("./layouts/project-layout.tsx")),
  validateSearch: z.object({
    settings: z.string().optional(),
  }),
});

// ============================================
// PROJECT ROUTES (available in all projects)
// ============================================

// Project home - the default view when entering a project
const projectHomeRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/",
  component: lazyRouteComponent(() => import("./routes/orgs/home/page.tsx")),
});

// Tasks placeholder (new)
const tasksRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/tasks",
  component: lazyRouteComponent(() => import("./routes/tasks.tsx")),
});

// Project settings (redirects to settings modal via search param)
const projectSettingsRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/settings",
  beforeLoad: ({ params }) => {
    const isOrgAdmin = params.project === ORG_ADMIN_PROJECT_SLUG;
    throw redirect({
      to: "/$org/$project",
      params,
      search: { settings: isOrgAdmin ? "org.general" : "project.general" },
    });
  },
  component: () => null,
});

// ============================================
// ORG-ADMIN EXCLUSIVE ROUTES
// ============================================

// Helper to guard org-admin routes
const orgAdminGuard = ({
  params,
}: {
  params: { org: string; project: string };
}) => {
  if (params.project !== ORG_ADMIN_PROJECT_SLUG) {
    throw redirect({
      to: "/$org/$project",
      params: { org: params.org, project: params.project },
    });
  }
};

// Projects list (new - org-admin only)
const projectsListRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/projects",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(() => import("./routes/projects-list.tsx")),
});

// Members
const membersRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/members",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(() => import("./routes/orgs/members.tsx")),
});

// Connections (mcps)
const connectionsRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/mcps",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(() => import("./routes/orgs/connections.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      action: z.enum(["create"]).optional(),
    }),
  ),
});

// Connection detail
const connectionDetailRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/mcps/$connectionId",
  beforeLoad: orgAdminGuard,
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
  getParentRoute: () => projectLayout,
  path: "/mcps/$connectionId/$collectionName/$itemId",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(
    () => import("./routes/orgs/collection-detail.tsx"),
  ),
  validateSearch: z.lazy(() =>
    z.object({
      replayId: z.string().optional(), // Random ID to lookup input in sessionStorage
    }),
  ),
});

// Monitoring (org-level, but requires org-admin project context)
const monitoringRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/monitoring",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(() => import("./routes/orgs/monitoring.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      tab: z.enum(["logs", "analytics", "dashboards"]).default("logs"),
      from: z.string().default("now-24h"),
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

// Dashboard view (org-admin only)
const dashboardViewRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/monitoring/dashboards/$dashboardId",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(
    () => import("./routes/orgs/monitoring-dashboard-view.tsx"),
  ),
});

// Dashboard edit (org-admin only, full editor page)
const dashboardEditRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/monitoring/dashboards/$dashboardId/edit",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(
    () => import("./routes/orgs/monitoring-dashboard-edit.tsx"),
  ),
});

// Store
const storeRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/store",
  beforeLoad: orgAdminGuard,
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

// Agents
const agentsRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/agents",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(() => import("./routes/orgs/agents.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      action: z.enum(["create"]).optional(),
    }),
  ),
});

const agentDetailRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/agents/$agentId",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(() => import("./routes/orgs/agent-detail.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      tab: z.string().optional(),
    }),
  ),
});

// Workflows (available for all projects)
const workflowsRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/workflows",
  component: lazyRouteComponent(() => import("./routes/orgs/workflow.tsx")),
});

// ============================================
// PLUGIN ROUTES
// ============================================

const pluginLayoutRoute = createRoute({
  getParentRoute: () => projectLayout, // Changed from shellLayout
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

const projectRoutes = [
  projectHomeRoute,
  tasksRoute,
  projectSettingsRoute,
  projectsListRoute,
  membersRoute,
  connectionsRoute,
  connectionDetailRoute,
  collectionDetailRoute,
  monitoringRoute,
  dashboardViewRoute,
  dashboardEditRoute,
  storeRouteWithChildren,
  agentsRoute,
  agentDetailRoute,
  workflowsRoute,
  pluginLayoutWithChildren,
];

const projectLayoutWithChildren = projectLayout.addChildren(projectRoutes);

const shellRouteTree = shellLayout.addChildren([
  homeRoute,
  orgRedirectRoute,
  projectLayoutWithChildren,
]);

const routeTree = rootRoute.addChildren([
  shellRouteTree,
  loginRoute,
  resetPasswordRoute,
  betterAuthRoutes,
  oauthCallbackRoute,
  connectRoute,
  storeInviteRoute,
  onboardingRoute,
  reportRoute,
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
