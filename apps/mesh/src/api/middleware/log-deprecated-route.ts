import type { MiddlewareHandler } from "hono";
import type { MeshContext } from "../../core/mesh-context";

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
 * `/api/:org/...`, the new sub-app handled the request and we suppress.
 * Otherwise the legacy path served the request — log it.
 */
export const logDeprecatedRoute: MiddlewareHandler<{
  Variables: { meshContext: MeshContext };
}> = async (c, next) => {
  await next();

  const matched = c.req.matchedRoutes ?? [];
  const realHandler = matched.find(
    (r) => r.method !== "ALL" && !r.path.endsWith("*"),
  );
  if (!realHandler || realHandler.path.startsWith("/api/:org/")) {
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
