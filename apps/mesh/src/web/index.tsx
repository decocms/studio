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

    // Filter out archived organizations — they are soft-deleted and invisible to the UI
    type OrgWithMeta = (typeof orgs)[number] & {
      metadata?: { archived?: boolean } | null;
    };
    const activeOrgs = (orgs as OrgWithMeta[]).filter(
      (o) => !o.metadata?.archived,
    );

    // Fast path: validate cached slug against current membership before redirecting.
    // If stale (org deleted/archived or user removed), clear it to prevent a redirect loop.
    const lastOrgSlug = localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    if (lastOrgSlug) {
      const slugIsValid = activeOrgs.some((o) => o.slug === lastOrgSlug);
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
    const firstOrg = activeOrgs[0];
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
    const { data: orgs } = await authClient.organization.list();
    type OrgWithMeta = NonNullable<typeof orgs>[number] & {
      metadata?: { archived?: boolean } | null;
    };
    const activeOrgs = (orgs as OrgWithMeta[] | undefined)?.filter(
      (o) => !o.metadata?.archived,
    );
    if (activeOrgs && activeOrgs.length > 0) {
      throw redirect({ to: "/" });
    }
  },
  component: lazyRouteComponent(() => import("./routes/onboarding.tsx")),
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
  component: lazyRouteComponent(() => import("./layouts/org-home/index.tsx")),
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
  connectionsRoute,
  connectionDetailRoute,
  collectionDetailRoute,
  settingsAgentsRoute,
  settingsAutomationsRoute,
  monitoringRoute,
  settingsGeneralRoute,
  settingsFeaturesRoute,
  settingsBrandContextRoute,
  settingsAiProvidersRoute,
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
  agentShellWithChildren,
]);

const orgLayoutWithChildren = orgLayout.addChildren([
  orgShellWithChildren,
  settingsWithChildren,
]);

const shellRouteTree = shellLayout.addChildren([
  homeRoute,
  orgLayoutWithChildren,
]);

const routeTree = rootRoute.addChildren([
  shellRouteTree,
  onboardingRoute,
  loginRoute,
  resetPasswordRoute,
  betterAuthRoutes,
  oauthCallbackRoute,
  oauthCallbackAiProviderRoute,
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
