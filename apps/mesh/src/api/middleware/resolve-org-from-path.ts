import type { Context, MiddlewareHandler } from "hono";
import type { StudioContext } from "../../core/studio-context";
import { rebindOrgScope } from "../../core/context-factory";
import { isOrgArchived } from "../../core/org-archived";

import { isBrowserNavigation } from "../utils/browser-navigation";

/**
 * Public-share endpoints a non-member must still reach: the read proxy
 * (`GET .../fs/:volume/read`, serves public/password files) and the password
 * unlock (`POST .../fs/:volume/unlock`). The membership gate below defers to
 * these; the routes themselves serve only shared content and still gate
 * everything else on ORG_FS_READ (a non-member fails → 403). Every other
 * org-scoped route stays member-gated.
 */
function isPublicSharePath(c: Context): boolean {
  const p = c.req.path;
  return (
    (c.req.method === "GET" && /\/fs\/[^/]+\/read$/.test(p)) ||
    (c.req.method === "POST" && /\/fs\/[^/]+\/unlock$/.test(p))
  );
}

export const resolveOrgFromPath: MiddlewareHandler<{
  Variables: { studioContext: StudioContext };
}> = async (c, next) => {
  const slug = c.req.param("org");
  if (!slug) {
    return c.json({ error: "org slug missing in path" }, 400);
  }

  const ctx = c.get("studioContext");
  if (!ctx?.db) {
    return c.json({ error: "studioContext not initialized" }, 500);
  }
  const db = ctx.db;

  // Only the vault service-lease resolves the org by id — its machine caller
  // (commerce-discovery) holds the org id, not the slug. Every other route stays
  // slug-only so a slug that happens to equal another org's id can never cause
  // cross-org resolution on an unauthenticated route.
  const isVaultServicePath =
    /\/vault\/connections\/[^/]+\/(access-token|configuration)$/.test(
      c.req.path,
    );
  const org = await db
    .selectFrom("organization")
    .select(["id", "slug", "name", "metadata"])
    .where((eb) =>
      isVaultServicePath
        ? eb.or([eb("slug", "=", slug), eb("id", "=", slug)])
        : eb("slug", "=", slug),
    )
    .executeTakeFirst();

  if (!org) {
    // Bounce browser navigations into the SPA so OrgAccessGate shows the
    // "Organization not found" screen instead of raw JSON.
    if (isBrowserNavigation(c)) {
      return c.redirect(`/${encodeURIComponent(slug)}`, 302);
    }
    return c.json({ error: `organization "${slug}" not found` }, 404);
  }

  // Archived (soft-deleted) orgs are invisible to the API. Treat them exactly
  // like a missing org: bounce browser navigations into the SPA (the shell
  // shows the branded "Organization unavailable" screen), and return JSON 404
  // to machine clients such as the self-MCP proxy POST.
  if (isOrgArchived(org)) {
    if (isBrowserNavigation(c)) {
      return c.redirect(`/${encodeURIComponent(slug)}`, 302);
    }
    return c.json({ error: `organization "${slug}" not found` }, 404);
  }

  const userId = ctx.auth?.user?.id;
  // For unauthenticated requests, set the org context but don't enforce
  // membership here. The downstream auth middleware (mcpAuth) needs to be the
  // one that returns 401 with WWW-Authenticate so OAuth-capable clients
  // (Cursor, Claude) can discover the protected-resource metadata URL and
  // start their OAuth flow. Blocking unauthenticated callers at THIS layer
  // with 403 short-circuits OAuth discovery entirely.
  //
  // The .well-known/oauth-protected-resource discovery endpoint also has to
  // be reachable without auth — same reason.
  //
  // Routes that need an authenticated principal still reject via their own
  // ctx.access.check() (UnauthorizedError → 401).
  let pathRole: string | undefined;
  if (userId) {
    const membership = await db
      .selectFrom("member")
      .select(["role"])
      .where("userId", "=", userId)
      .where("organizationId", "=", org.id)
      .executeTakeFirst();

    if (!membership) {
      // Public-share reads + password unlock are reachable by anyone, incl.
      // signed-in non-members — let them fall through to the route (which serves
      // only shared content and 403s the rest). All other routes stay gated.
      if (!isPublicSharePath(c)) {
        // Bounce browser navigations into the SPA so OrgAccessGate shows the
        // styled "No access" screen (with invite/auto-join handling) instead of
        // raw JSON in the address bar.
        if (isBrowserNavigation(c)) {
          return c.redirect(`/${encodeURIComponent(org.slug)}`, 302);
        }
        return c.json(
          { error: "forbidden: not a member of organization" },
          403,
        );
      }
      // pathRole stays undefined; the org is still resolved + rebound below so
      // the read route can stat the file and serve it if it's public.
    } else {
      pathRole = membership.role;
    }
  }

  ctx.organization = {
    id: org.id,
    slug: org.slug,
    name: org.name,
    role: pathRole,
  };
  // Tell AccessControl to use the path-resolved org for permission checks.
  // Without this, boundAuth.hasPermission falls back to the session's
  // activeOrganizationId — which races with signup in CI and can be stale or
  // pointing at a different org than the URL.
  ctx.access.setOrganizationId(org.id);
  // Also propagate the user's role in the path-resolved org. AccessControl's
  // built-in admin/owner bypass reads `this.role`, which was set at
  // construction time from the session's active org. When the path targets a
  // different org — or when there's no active org and the role was undefined
  // — the bypass silently fails and owners get spurious 403s on tool calls.
  ctx.access.setRole(pathRole);
  // Everything org-scoped on the context (thread storage, object storage,
  // org-fs, asset hoisters) was constructed eagerly from the session's active
  // org — or from no org at all. Rebind it all to the path-resolved org so
  // cross-org navigation (session active=A, URL targets B) reads and writes
  // B's tenant scope, never A's.
  rebindOrgScope(ctx, org);

  return await next();
};
