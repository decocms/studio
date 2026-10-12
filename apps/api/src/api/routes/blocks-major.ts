/**
 * Main's schema answer, which the site editor waits for before it picks a
 * backend (once per project per session):
 *
 *   POST /api/:org/blocks-major/:virtualMcpId
 *     → 200 { isV8: boolean | null, hostedSite: boolean | null }
 *     → 502 { code: "main_unreadable" } when main couldn't be read
 *
 * Runs `isV8Schema` on main's `.deco/schema.gen.json` (`mainIsV8`, an
 * ETag-cached head read and a per-commit answer in steady state) and writes
 * the answer through to `metadata.blocksMajor`, the server's cache of it
 * (hosted/blocks-major.ts). The web app decides from `isV8` alone, never from
 * that marker. `isV8: null` when the project has no repository (no main: not
 * a v8 site). A failed read is an error, never a "v7" the editor would act
 * on. `hostedSite` says whether a v8 project owns its site id
 * (`ownedProjectSite`), which the hosted CMS needs; null when the project
 * isn't v8 (no extra read for v7).
 */

import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import { Hono } from "hono";
import { resolveCallerProjectScope } from "@/core/project-scope";
import { contentClientForProjectRepo } from "@/git-providers";
import { readMainBlocksMajor } from "@/hosted/blocks-major";
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
    let read: Awaited<ReturnType<typeof readMainBlocksMajor>>;
    try {
      read = await readMainBlocksMajor({
        projects: ctx.storage.virtualMcps,
        project: {
          id: virtualMcpId,
          organizationId: organization.id,
          metadata,
        },
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
    } catch (error) {
      console.warn("blocks-major: main's schema couldn't be read", {
        organizationId: organization.id,
        projectId: virtualMcpId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { error: "main's schema couldn't be read", code: "main_unreadable" },
        502,
        { "Cache-Control": "no-store" },
      );
    }
    const isV8 = read === "no-repository" ? null : read.isV8;
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
