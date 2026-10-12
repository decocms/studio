/**
 * Refreshes a project's Blocks v8 marker when it is opened (session):
 *
 *   POST /api/:org/blocks-major/:virtualMcpId
 *     → { isV8: boolean | null, hostedSite: boolean | null }
 *
 * Runs `isV8Schema` on main's `.deco/schema.gen.json` (`mainIsV8`, an
 * ETag-cached head read in steady state) and writes the answer through to
 * `metadata.blocksMajor` (hosted/blocks-major.ts). This is how a site whose
 * repository was seeded after create, or that upgraded to v8 (or went back to
 * v7) later, gets the right editor. `null` when the project has no repository
 * or main couldn't be read; the marker is then left as it is. `hostedSite`
 * says whether a v8 project owns its site id (`ownedProjectSite`), which the
 * hosted CMS needs; null when the project isn't v8 (no extra read for v7).
 */

import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import { Hono } from "hono";
import { resolveCallerProjectScope } from "@/core/project-scope";
import { contentClientForProjectRepo } from "@/git-providers";
import { refreshBlocksMajorMarker } from "@/hosted/blocks-major";
import { ownedProjectSite } from "@/hosted/scope";
import { parseRepositoryBinding } from "@/tools/sandbox/sync-git-credentials";
import type { Env } from "../hono-env";

export function createBlocksMajorRoutes(
  options: { repoClientFor?: typeof contentClientForProjectRepo } = {},
) {
  const app = new Hono<Env>();
  const repoClientFor = options.repoClientFor ?? contentClientForProjectRepo;

  app.post("/:virtualMcpId", async (c) => {
    const ctx = c.var.studioContext;
    const organization = ctx.organization;
    if (!organization) {
      return c.json({ error: "Organization scope required" }, 500);
    }
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const virtualMcpId = c.req.param("virtualMcpId");
    const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
    if (
      !virtualMcp ||
      virtualMcp.organization_id !== organization.id ||
      !isProjectAllowed(await resolveCallerProjectScope(ctx), virtualMcpId)
    ) {
      return c.json({ error: "Virtual MCP not found" }, 404);
    }
    const metadata = (virtualMcp.metadata as Record<string, unknown>) ?? null;
    const isV8 = await refreshBlocksMajorMarker({
      projects: ctx.storage.virtualMcps,
      project: { id: virtualMcpId, organizationId: organization.id, metadata },
      by: userId,
      client: async () => {
        const repository = parseRepositoryBinding(
          metadata,
          virtualMcp.connections?.map((conn) => conn.connection_id) ?? [],
        );
        return repository
          ? repoClientFor(ctx, organization.id, repository)
          : null;
      },
    });
    const hostedSite = isV8
      ? (await ownedProjectSite(
          ctx.storage.orgSites,
          virtualMcpId,
          organization.id,
        )) !== null
      : null;
    return c.json({ isV8, hostedSite }, 200, { "Cache-Control": "no-store" });
  });

  return app;
}
