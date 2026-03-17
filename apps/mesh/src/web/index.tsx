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
import { ORG_ADMIN_PROJECT_SLUG } from "@decocms/mesh-sdk";

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
          to: "/$org/$project",
          params: { org: lastOrgSlug, project: ORG_ADMIN_PROJECT_SLUG },
        });
      }
      // Stale — remove so future visits don't loop
      localStorage.removeItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    }

    // Slow path: first-time user — redirect if they only have one org
    const onlyOrg = orgs.length === 1 ? orgs[0] : undefined;
    if (onlyOrg) {
      throw redirect({
        to: "/$org/$project",
        params: { org: onlyOrg.slug, project: ORG_ADMIN_PROJECT_SLUG },
      });
    }
  },
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

// Project settings — layout for /$org/$project/settings/*
const projectSettingsRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/settings",
  beforeLoad: ({ params }) => {
    const isOrgAdmin = params.project === ORG_ADMIN_PROJECT_SLUG;
    if (isOrgAdmin) {
      throw redirect({
        to: "/$org/$project",
        params,
        search: { settings: "org.general" },
      });
    }
  },
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/layout.tsx"),
  ),
});

const projectSettingsDirectIndexRoute = createRoute({
  getParentRoute: () => projectSettingsRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/$project/settings/general",
      params: { org: params.org, project: params.project },
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

// Project settings (org-admin only - dedicated page)
const projectSettingsLayout = createRoute({
  getParentRoute: () => projectLayout,
  path: "/projects/$slug/settings",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/layout.tsx"),
  ),
});

const projectSettingsIndexRoute = createRoute({
  getParentRoute: () => projectSettingsLayout,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$org/$project/projects/$slug/settings/general",
      params,
    });
  },
  component: () => null,
});

const projectSettingsGeneralRoute = createRoute({
  getParentRoute: () => projectSettingsLayout,
  path: "/general",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/general.tsx"),
  ),
});

const projectSettingsDependenciesRoute = createRoute({
  getParentRoute: () => projectSettingsLayout,
  path: "/dependencies",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/dependencies.tsx"),
  ),
});

const projectSettingsSidebarRoute = createRoute({
  getParentRoute: () => projectSettingsLayout,
  path: "/sidebar",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/sidebar-settings.tsx"),
  ),
});

const projectSettingsPluginsRoute = createRoute({
  getParentRoute: () => projectSettingsLayout,
  path: "/plugins",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/plugins.tsx"),
  ),
});

const projectSettingsDangerRoute = createRoute({
  getParentRoute: () => projectSettingsLayout,
  path: "/danger",
  component: lazyRouteComponent(
    () => import("./routes/orgs/project-settings/danger.tsx"),
  ),
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

// Automations
const automationsRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/automations",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(() => import("./routes/orgs/automations.tsx")),
});

const automationDetailRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/automations/$automationId",
  beforeLoad: orgAdminGuard,
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

// Pinned App View (available for all projects)
const projectAppViewRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/apps/$connectionId/$toolName",
  component: lazyRouteComponent(() => import("./routes/project-app-view.tsx")),
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

const projectSettingsWithChildren = projectSettingsLayout.addChildren([
  projectSettingsIndexRoute,
  projectSettingsGeneralRoute,
  projectSettingsDependenciesRoute,
  projectSettingsSidebarRoute,
  projectSettingsPluginsRoute,
  projectSettingsDangerRoute,
]);

const projectSettingsDirectWithChildren = projectSettingsRoute.addChildren([
  projectSettingsDirectIndexRoute,
  projectSettingsDirectGeneralRoute,
  projectSettingsDirectDependenciesRoute,
  projectSettingsDirectSidebarRoute,
  projectSettingsDirectPluginsRoute,
  projectSettingsDirectDangerRoute,
]);

const projectRoutes = [
  projectHomeRoute,
  tasksRoute,
  projectSettingsDirectWithChildren,
  projectsListRoute,
  projectSettingsWithChildren,
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
  workflowsRoute,
  projectAppViewRoute,
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
