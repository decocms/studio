import type { MiddlewareHandler } from "hono";
import type { MeshContext } from "../../core/mesh-context";

type Variables = { meshContext: MeshContext };

/**
 * Permanent (non-deprecated) routes that any legacy deprecation middleware
 * may incorrectly attribute to itself. Hono mounts multiple legacy sub-apps
 * at broad prefixes (e.g. `/`, `/api`); each one's wildcard middleware fires
 * for every request matching the prefix and inspects `c.req.matchedRoutes`,
 * so a permanent sibling's handler can be misidentified as the deprecated
 * route. Suppress those globally here rather than threading per-mount
 * allowlists through every legacy registration.
 *
 * Add a path here when a permanent route shows up in production deprecation
 * logs.
 */
const PERMANENT_ROUTES: ReadonlySet<string> = new Set([
  "/api/deco-sites/profile",
]);

interface LogDeprecatedRouteOptions {
  /**
   * Mount path of the legacy sub-app this middleware is attached to.
   *
   * Hono runs `use("*", ...)` for every request whose URL prefix-matches the
   * sub-app's mount, even when a sibling sub-app at a longer-prefix mount
   * actually serves the response. Suppress when the responding handler's
   * `basePath` doesn't match this mount path — that means a sibling at a
   * different prefix served it.
   *
   * For permanent siblings mounted at the SAME prefix (where basePath
   * cannot distinguish them), add the path to `PERMANENT_ROUTES` above
   * instead.
   */
  mountPath?: string;
}

/**
 * Logs a `"deprecated route"` line for legacy route hits during the
 * org-scoped-API deprecation window.
 */
const buildLogDeprecatedRoute =
  (
    options: LogDeprecatedRouteOptions = {},
  ): MiddlewareHandler<{ Variables: Variables }> =>
  async (c, next) => {
    await next();

    const matched = c.req.matchedRoutes ?? [];
    const realHandler = matched.find(
      (r) => r.method !== "ALL" && !r.path.endsWith("*"),
    );
    if (!realHandler) return;

    // Globally permanent routes — never log these regardless of which legacy
    // sub-app's wildcard fired.
    if (PERMANENT_ROUTES.has(realHandler.path)) return;

    // Suppress when the responding handler lives in the org-scoped sub-app.
    // Belt-and-suspenders for mounts without `mountPath` (e.g. sub-apps
    // mounted at `/` where basePath alone can't distinguish siblings).
    if (realHandler.path.startsWith("/api/:org/")) return;

    if (
      options.mountPath !== undefined &&
      realHandler.basePath !== options.mountPath
    ) {
      return;
    }

    const ctx = c.get("meshContext");
    console.log("deprecated route", {
      route: c.req.routePath,
      method: c.req.method,
      org: ctx?.organization?.slug,
      user: ctx?.auth?.user?.id,
      ua: c.req.header("user-agent"),
    });
  };

export const logDeprecatedRoute = buildLogDeprecatedRoute();

export const createLogDeprecatedRoute = (options: LogDeprecatedRouteOptions) =>
  buildLogDeprecatedRoute(options);
