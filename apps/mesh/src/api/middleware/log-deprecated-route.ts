import type { MiddlewareHandler } from "hono";
import type { MeshContext } from "../../core/mesh-context";

type Variables = { meshContext: MeshContext };

interface LogDeprecatedRouteOptions {
  /**
   * Hono route paths that share this sub-app's mount prefix but belong to a
   * permanent (non-deprecated) sibling sub-app. Hono runs the wildcard
   * middleware for every request matching the mount prefix, so without this
   * exclusion list a permanent sibling's routes would be logged as
   * deprecated whenever the two sub-apps are mounted at the same prefix.
   */
  permanentSiblings?: ReadonlySet<string>;
}

/**
 * Logs a `"deprecated route"` line for legacy route hits during the
 * org-scoped-API deprecation window.
 *
 * The middleware is attached via `app.use("*", logDeprecatedRoute)` on each
 * legacy sub-app, which Hono treats as a path-prefix middleware. That
 * wildcard fires on every request whose URL prefix-matches the parent mount —
 * including hits to the new `/api/:org/*` mount that shares the `/api`
 * prefix. Without a guard, every new-path call would emit a spurious
 * deprecation log.
 *
 * Detection: walk `c.req.matchedRoutes` (populated by Hono after routing) for
 * a non-wildcard handler. If no real handler matched, the sub-app fell
 * through and we suppress. If the matched handler lives under
 * `/api/:org/...`, the new sub-app handled the request and we suppress. If
 * the matched handler is in `permanentSiblings`, a permanent sub-app sharing
 * this mount handled it and we suppress. Otherwise the legacy path served
 * the request — log it.
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
    if (!realHandler || realHandler.path.startsWith("/api/:org/")) {
      return;
    }
    if (options.permanentSiblings?.has(realHandler.path)) {
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
