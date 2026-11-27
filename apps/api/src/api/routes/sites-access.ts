/**
 * `GET /api/:org/sites/:site/access`: what the caller may do on one of the
 * organization's v8 sites. sites.decocms.com keeps no organizations or
 * members of its own and asks this route on every request.
 *
 * `resolveOrgFromPath` has already resolved `:org` and refused a non-member
 * (403). The caller authenticates with a browser session, an MCP OAuth
 * access token, or an `x-studio-token` alone (see `isStudioTokenOnlyRoute`
 * in `core/context-factory.ts`). The site is resolved as `/api/cms/:site`
 * resolves it: its `org_sites` row, which must belong to `:org` (404
 * otherwise, the same answer as an unknown site), then the caller's project
 * scope over its project (403). `canRead` / `canWrite` are the `CMS_READ` /
 * `CMS_WRITE` checks the CMS routes apply to reads and writes; a blocked
 * organization cannot write. `cmsFeature` is the `cms` plan gate, reported
 * rather than enforced.
 */

import { isBlocksV8Project } from "@decocms/shared/blocks-major";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import { CMS_PERMISSIONS } from "@decocms/shared/tools/registry-metadata";
import { type Context, Hono } from "hono";
import { isOrgBlocked } from "@/core/org-notice-gate";
import { orgHasFeature } from "@/core/plan-feature-gate";
import type { Env } from "../hono-env";
import { siteProject, siteProjectAllowed } from "./cms";

const NO_STORE = { "Cache-Control": "no-store" };

function fail(
  c: Context<Env>,
  status: 401 | 403 | 404,
  code: string,
  error: string,
) {
  return c.json({ error, code }, status, NO_STORE);
}

export function createSitesAccessRoutes() {
  const app = new Hono<Env>();

  app.get("/:site/access", async (c) => {
    const ctx = c.var.studioContext;
    if (!ctx.auth.user?.id) {
      return fail(c, 401, "unauthorized", "Unauthorized");
    }
    const org = ctx.organization;
    if (!org || org.role === undefined) {
      return fail(c, 403, "forbidden", "Not a member of this organization");
    }

    const row = await ctx.storage.orgSites.getBySlug(c.req.param("site"));
    if (!row || row.organizationId !== org.id) {
      return fail(c, 404, "site_not_found", "Site not found");
    }
    if (!(await siteProjectAllowed(ctx, row.projectId))) {
      return fail(
        c,
        403,
        "project_not_allowed",
        "This site's project is outside your access",
      );
    }

    const [canRead, holdsWrite, blocked, cmsFeature, project] =
      await Promise.all([
        ctx.access.holds(CMS_PERMISSIONS.read),
        ctx.access.holds(CMS_PERMISSIONS.write),
        ctx.db ? isOrgBlocked(ctx.db, org.id) : false,
        orgHasFeature(ctx, org.id, "cms"),
        siteProject(ctx, row.projectId, org.id),
      ]);
    if (!canRead) {
      return fail(c, 403, "forbidden", "No CMS access to this site");
    }

    return c.json(
      {
        org: { id: org.id, slug: org.slug, name: org.name },
        site: row.slug,
        project: project ? { id: project.id, title: project.title } : null,
        blocksV8: isBlocksV8Project(project?.metadata),
        role: org.role,
        canRead,
        canWrite: holdsWrite && !blocked,
        cmsFeature,
        previewUrl: resolvePreviewServerUrl(project?.metadata),
      },
      200,
      NO_STORE,
    );
  });

  return app;
}
