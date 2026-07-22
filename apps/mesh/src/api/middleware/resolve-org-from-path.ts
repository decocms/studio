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

/**
 * Return the organization bound into an API key's metadata, if present.
 * Keys created for org-scoped access carry `metadata.organization.id`.
 * Legacy/internal keys without that field are left to their existing route
 * authorization rules; a malformed explicit organization binding fails closed.
 */
function getApiKeyOrganizationBinding(ctx: StudioContext): {
  present: boolean;
  id?: string;
} {
  const metadata = ctx.auth?.apiKey?.metadata;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !("organization" in metadata)
  ) {
    return { present: false };
  }

  const organization = metadata.organization;
  if (
    !organization ||
    typeof organization !== "object" ||
    Array.isArray(organization)
  ) {
    return { present: true };
  }

  const id = (organization as Record<string, unknown>).id;
  return { present: true, id: typeof id === "string" ? id : undefined };
}

/**
 * The exhaustive list of service-token routes that resolve the org by ID —
 * their machine caller (commerce-discovery) holds the org id, not the slug.
 * One entry per route, as the path segments AFTER `/api/:org` (`"*"` matches
 * exactly one dynamic segment). Every other route stays slug-only so a slug
 * that happens to equal another org's id can never cause cross-org resolution
 * on an unauthenticated route.
 */
const SERVICE_TOKEN_ROUTES: readonly (readonly string[])[] = [
  ["vault", "connections", "*", "access-token"],
  ["vault", "connections", "*", "configuration"],
  ["internal", "task-board", "import"],
];

/**
 * Segment-exact matcher for SERVICE_TOKEN_ROUTES over a full request path
 * (`/api/:org/...`). Stricter than the suffix regex it replaced: the route
 * shape must sit DIRECTLY under `/api/:org`, so a longer path that merely
 * ends in a service suffix (e.g. an MCP proxy echo of it) can never resolve
 * by id. Pure — exported for unit tests.
 */
export function isServiceTokenPath(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  if (segs[0] !== "api") return false;
  const rest = segs.slice(2); // drop "api" + the :org segment
  return SERVICE_TOKEN_ROUTES.some(
    (route) =>
      route.length === rest.length &&
      route.every((seg, i) => seg === "*" || seg === rest[i]),
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

  // Service-token routes (see SERVICE_TOKEN_ROUTES) may resolve the org by id;
  // everything else is slug-only.
  const allowIdResolution = isServiceTokenPath(c.req.path);
  const org = await db
    .selectFrom("organization")
    .select(["id", "slug", "name", "metadata"])
    .where((eb) =>
      allowIdResolution
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

  // API keys are capabilities bound to the organization that minted them.
  // Do this check before membership/rebinding so a valid key from org B cannot
  // be reused against org A merely because its owner is also an A member.
  const apiKeyBinding = getApiKeyOrganizationBinding(ctx);
  if (
    ctx.auth?.apiKey?.id &&
    apiKeyBinding.present &&
    apiKeyBinding.id !== org.id
  ) {
    return c.json(
      { error: "forbidden: API key is scoped to another organization" },
      403,
    );
  }

  if (
    ctx.auth?.tokenOrganizationId &&
    ctx.auth.tokenOrganizationId !== org.id
  ) {
    return c.json(
      { error: "forbidden: token is scoped to another organization" },
      403,
    );
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
