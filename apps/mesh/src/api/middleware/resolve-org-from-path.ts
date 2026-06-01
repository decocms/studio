import type { MiddlewareHandler } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import { createBoundObjectStorage } from "../../object-storage/bound-object-storage";
import { DevObjectStorage } from "../../object-storage/dev-object-storage";
import { decorateStorageWithAssetHoisting } from "../../object-storage/asset-hoister";
import { getObjectStorageS3Service } from "../../object-storage/factory";

import { isBrowserNavigation } from "../utils/browser-navigation";

export const resolveOrgFromPath: MiddlewareHandler<{
  Variables: { meshContext: MeshContext };
}> = async (c, next) => {
  const slug = c.req.param("org");
  if (!slug) {
    return c.json({ error: "org slug missing in path" }, 400);
  }

  const ctx = c.get("meshContext");
  if (!ctx?.db) {
    return c.json({ error: "meshContext not initialized" }, 500);
  }
  const db = ctx.db;

  const org = await db
    .selectFrom("organization")
    .select(["id", "slug", "name", "metadata"])
    .where("slug", "=", slug)
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
  if (org.metadata) {
    try {
      const meta = JSON.parse(org.metadata) as Record<string, unknown>;
      if (meta.archived === true) {
        if (isBrowserNavigation(c)) {
          return c.redirect(`/${encodeURIComponent(slug)}`, 302);
        }
        return c.json({ error: `organization "${slug}" not found` }, 404);
      }
    } catch {
      // Unparseable metadata — treat as not archived
    }
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
      // Bounce browser navigations into the SPA so OrgAccessGate shows the
      // styled "No access" screen (with invite/auto-join handling) instead of
      // raw JSON in the address bar.
      if (isBrowserNavigation(c)) {
        return c.redirect(`/${encodeURIComponent(org.slug)}`, 302);
      }
      return c.json({ error: "forbidden: not a member of organization" }, 403);
    }
    pathRole = membership.role;
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
  // Rebind org-scoped storage that was constructed eagerly with `undefined`
  // when meshContext was created (no `x-org-id` header on the new path
  // means `organization` was not yet resolved). Without this, any thread
  // operation throws "thread operations require an authenticated organization".
  ctx.storage.threads.setOrganizationId(org.id);
  ctx.storage.asyncResearchJobs.setOrganizationId(org.id);
  // objectStorage was constructed eagerly from the session's active org (or
  // null when unauthenticated). Always rebind to the path-resolved org so
  // cross-org navigation — e.g. session active=A, URL targets B — reads from
  // B's tenant scope, not A's.
  const s3Service = getObjectStorageS3Service();
  ctx.objectStorage = s3Service
    ? createBoundObjectStorage(s3Service, org.id)
    : new DevObjectStorage(org.id, ctx.baseUrl);
  // Asset hoisters close over object storage and org slug. Context creation can
  // happen before path-org resolution, so refresh the wrappers after rebinding
  // object storage to avoid writing files into the session-active org.
  decorateStorageWithAssetHoisting(ctx.storage, {
    objectStorage: ctx.objectStorage,
    baseUrl: ctx.baseUrl,
    orgSlug: org.slug,
  });

  return await next();
};
