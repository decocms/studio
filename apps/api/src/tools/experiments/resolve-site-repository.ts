import type { StudioContext } from "../../core/studio-context";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { findRepositoryForBinding } from "@/git-providers/repository-binding";
import type { RepositoryBinding } from "@decocms/shared/sdk";

/**
 * The Studio `repositories` row id backing `site`'s GitHub repo, or `null`
 * when the site has no linked repository yet (e.g. a project not connected
 * to GitHub) — a site in that state simply can't be delegated to the Super
 * Agent, which needs a repo to check out.
 *
 * Resolves `metadata.repository` the same way sandbox start does: the
 * binding's `repositoryId` when it has one, else the organization's
 * repository matching its host and path, since an imported project carries
 * a binding that names no repository row.
 */
export async function resolveSiteRepositoryId(
  ctx: StudioContext,
  organizationId: string,
  site: string,
): Promise<string | null> {
  const projects = await ctx.storage.virtualMcps.list(organizationId);
  const project = projects.find((vm) => resolveAgentSiteSlug(vm) === site);
  const binding = (
    project?.metadata as { repository?: RepositoryBinding | null } | null
  )?.repository;
  if (!binding) return null;
  const repository = await findRepositoryForBinding(
    ctx.storage,
    organizationId,
    binding,
  );
  return repository?.id ?? null;
}
