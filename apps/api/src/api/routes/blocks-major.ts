/**
 * Refreshes a project's Blocks v8 marker when it is opened (session):
 *
 *   POST /api/:org/blocks-major/:virtualMcpId   → { isV8: boolean | null }
 *
 * Runs `isV8Schema` on main's `.deco/schema.gen.json` (`mainIsV8`, an
 * ETag-cached head read in steady state) and writes the answer through to
 * `metadata.blocksMajor` (hosted/blocks-major.ts). This is how a site whose
 * repository was seeded after create, or that upgraded to v8 (or went back to
 * v7) later, gets the right editor. `null` when the project has no repository
 * or main couldn't be read; the marker is then left as it is.
 */

import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import { Hono } from "hono";
import { resolveCallerProjectScope } from "@/core/project-scope";
import { contentClientForProjectRepo } from "@/git-providers";
import { refreshBlocksMajorMarker } from "@/hosted/blocks-major";
import { parseRepositoryBinding } from "@/tools/sandbox/sync-git-credentials";
import type { Env } from "../hono-env";

export function createBlocksMajorRoutes() {
  const app = new Hono<Env>();

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
          ? contentClientForProjectRepo(ctx, organization.id, repository)
          : null;
      },
    });
    return c.json({ isV8 }, 200, { "Cache-Control": "no-store" });
  });

  return app;
}
