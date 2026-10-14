import type { StudioContext } from "../../core/studio-context";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";

/**
 * The Studio `repositories` row id backing an already-resolved project's
 * GitHub repo, or `null` when the project has no linked repository yet (e.g.
 * a project not connected to GitHub) — a site in that state simply can't be
 * delegated to the Super Agent, which needs a repo to check out.
 *
 * Reads `metadata.repository.repositoryId`, the same first-class binding
 * `VirtualMCPStorage` writes on create/update (see `boundRepositoryId` in
 * `storage/virtual.ts`) — not a `repositories` table lookup by owner/name,
 * which would fail for a repo connected under a different identity string.
 */
export async function resolveRepositoryIdForProject(
  ctx: StudioContext,
  organizationId: string,
  project: { metadata: unknown },
): Promise<string | null> {
  const projects = await ctx.storage.virtualMcps.list(organizationId);
  const project = projects.find((vm) => resolveAgentSiteSlug(vm) === site);
  const repositoryId = (
    project?.metadata as { repository?: { repositoryId?: unknown } } | null
  )?.repository?.repositoryId;
  return typeof repositoryId === "string" && repositoryId.length > 0
    ? repositoryId
    : null;
}

/**
 * The Studio `repositories` row id backing `site`'s GitHub repo, or `null`
 * when the site has no linked repository yet. Finds the project the same
 * way ownership does, so a slug linked in `org_sites` resolves to its
 * project rather than only to one whose own slug matches.
 */
export async function resolveSiteRepositoryId(
  ctx: StudioContext,
  organizationId: string,
  site: string,
): Promise<string | null> {
  const project = await findOwnedProject(ctx, organizationId, site);
  return resolveRepositoryIdForProject(ctx, organizationId, project);
}
