import type { StudioContext } from "../../core/studio-context";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";

/**
 * The Studio `repositories` row id backing `site`'s GitHub repo, or `null`
 * when the site has no linked repository yet (e.g. a project not connected
 * to GitHub) — a site in that state simply can't be delegated to the Super
 * Agent, which needs a repo to check out.
 *
 * Reads `metadata.githubRepo.repositoryId`, the same first-class binding
 * `VirtualMCPStorage` writes on create/update (see `boundRepositoryId` in
 * `storage/virtual.ts`) — not a `repositories` table lookup by owner/name,
 * which would fail for a repo connected under a different identity string.
 */
export async function resolveSiteRepositoryId(
  ctx: StudioContext,
  organizationId: string,
  site: string,
): Promise<string | null> {
  const projects = await ctx.storage.virtualMcps.list(organizationId);
  const project = projects.find((vm) => resolveAgentSiteSlug(vm) === site);
  const repositoryId = (
    project?.metadata as { githubRepo?: { repositoryId?: unknown } } | null
  )?.githubRepo?.repositoryId;
  return typeof repositoryId === "string" && repositoryId.length > 0
    ? repositoryId
    : null;
}
