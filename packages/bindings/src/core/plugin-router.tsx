import type { ReactNode } from "react";
import {
  createRoute,
  lazyRouteComponent,
  Route,
  useNavigate,
  useParams,
  useSearch,
  useLocation,
  Link as TanStackLink,
  type AnyRoute,
  type RouteIds,
  type RouteById,
  type LinkProps,
  type NavigateOptions,
} from "@tanstack/react-router";
import type { PluginSetupContext } from "./plugins";

/**
 * Prepends the plugin base path (/$org/projects/$virtualMcpId/$pluginId) to a route path.
 * Handles both absolute plugin paths (starting with /) and relative paths.
 */
function prependBasePath(
  to: string | undefined,
  org: string,
  virtualMcpId: string,
  pluginId: string,
): string {
  if (!to) return `/${org}/projects/${virtualMcpId}/${pluginId}`;

  // If path starts with /, it's relative to the plugin root
  if (to.startsWith("/")) {
    return `/${org}/projects/${virtualMcpId}/${pluginId}${to}`;
  }

  // Otherwise, it's already a full path or relative
  return to;
}

/**
 * Creates a typed plugin router from a route factory function.
 *
 * Routes are registered directly under ctx.parentRoute (which already has
 * component: Outlet). Return an array of sibling routes for multiple pages.
 *
 * @example
 * ```tsx
 * export const storeRouter = createPluginRouter((ctx) => {
 *   const indexRoute = ctx.routing.createRoute({
 *     getParentRoute: () => ctx.parentRoute,
 *     path: "/",
 *     component: ctx.routing.lazyRouteComponent(() => import("./routes/page.tsx")),
 *   });
 *
 *   const detailRoute = ctx.routing.createRoute({
 *     getParentRoute: () => ctx.parentRoute,
 *     path: "/$appName",
 *     component: ctx.routing.lazyRouteComponent(() => import("./routes/detail.tsx")),
 *     validateSearch: z.object({ tab: z.string().optional() }),
 *   });
 *
 *   return [indexRoute, detailRoute];
 * });
 *
 * // In plugin setup - register each route
 * export const storePlugin: AnyPlugin = {
 *   id: "store",
 *   setup: (ctx) => {
 *     const routes = storeRouter.createRoutes(ctx);
 *     for (const route of routes) {
 *       ctx.registerRootPluginRoute(route);
 *     }
 *   },
 * };
 *
 * // In components
 * function DetailPage() {
 *   const { appName } = storeRouter.useParams({ from: "/$appName" });
 *   const { tab } = storeRouter.useSearch({ from: "/$appName" });
 *
 *   const navigate = storeRouter.useNavigate();
 *   navigate({ to: "/$appName", params: { appName: "other" } });
 * }
 * ```
 */
export function createPluginRouter<TRoutes extends AnyRoute | AnyRoute[]>(
  createRoutes: (ctx: PluginSetupContext) => TRoutes,
) {
  // Extract route type from array or single route
  type TRoute = TRoutes extends (infer R)[] ? R : TRoutes;
  type TRouteId = TRoute extends AnyRoute ? RouteIds<TRoute> : never;
  type TRouteById<TId extends TRouteId> = TRoute extends AnyRoute
    ? RouteById<TRoute, TId>
    : never;

  return {
    /**
     * Create the route tree. Call this in your plugin's setup().
     */
    createRoutes,

    /**
     * Get route params with TanStack's type inference.
     */
    useParams: <TFrom extends TRouteId>(_options: { from: TFrom }) => {
      return useParams({
        strict: false,
      }) as TRouteById<TFrom>["types"]["allParams"];
    },

    /**
     * Get search params with TanStack's type inference.
     */
    useSearch: <TFrom extends TRouteId>(_options: { from: TFrom }) => {
      return useSearch({
        strict: false,
      }) as TRouteById<TFrom>["types"]["fullSearchSchema"];
    },

    /**
     * Navigate within the plugin.
     * Automatically prepends /$org/$pluginId to the path.
     */
    useNavigate: () => {
      const navigate = useNavigate();
      const { org, virtualMcpId, pluginId } = useParams({ strict: false }) as {
        org: string;
        virtualMcpId: string;
        pluginId: string;
      };

      return <TTo extends TRouteId>(
        options: Omit<NavigateOptions, "to" | "params"> & {
          to: TTo;
          params?: TRouteById<TTo>["types"]["allParams"];
          search?: TRouteById<TTo>["types"]["fullSearchSchema"];
        },
      ) => {
        const to = prependBasePath(options.to, org, virtualMcpId, pluginId);

        return navigate({
          ...options,
          to,
          params: {
            org,
            virtualMcpId,
            pluginId,
            ...(options.params as Record<string, string>),
          },
        } as NavigateOptions);
      };
    },

    /**
     * Get the current location.
     */
    useLocation: () => {
      return useLocation();
    },

    /**
     * Link component for plugin navigation.
     * Automatically prepends /$org/$pluginId to the path.
     */
    Link: function PluginLink<TTo extends TRouteId>(
      props: Omit<LinkProps, "to" | "params" | "search"> & {
        to: TTo;
        params?: TRouteById<TTo>["types"]["allParams"];
        search?: TRouteById<TTo>["types"]["fullSearchSchema"];
        className?: string;
        children?: ReactNode;
      },
    ) {
      const { org, virtualMcpId, pluginId } = useParams({ strict: false }) as {
        org: string;
        virtualMcpId: string;
        pluginId: string;
      };

      const to = prependBasePath(
        props.to as string,
        org,
        virtualMcpId,
        pluginId,
      );

      return (
        <TanStackLink
          {...(props as LinkProps)}
          to={to}
          params={{
            org,
            virtualMcpId,
            pluginId,
            ...props.params,
          }}
        />
      );
    },

    /**
     * Type helpers
     */
    _types: {
      routes: undefined as unknown as TRoutes,
      routeIds: undefined as unknown as TRouteId,
    },
  };
}

/**
 * Type helper to extract route IDs from a plugin router
 */
export type PluginRouteIds<
  TRouter extends ReturnType<typeof createPluginRouter>,
> = TRouter["_types"]["routeIds"];

/**
 * Type helper to extract routes from a plugin router
 */
export type PluginRoutes<
  TRouter extends ReturnType<typeof createPluginRouter>,
> = TRouter["_types"]["routes"];

// Re-export TanStack utilities for plugins
export {
  createRoute,
  lazyRouteComponent,
  Route,
  TanStackLink as Link,
  useNavigate,
  useParams,
  useSearch,
  useLocation,
};
export type { AnyRoute, RouteIds, RouteById };
