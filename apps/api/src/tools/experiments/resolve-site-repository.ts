import type { StudioContext } from "../../core/studio-context";
import { findRepositoryForBinding } from "@/git-providers/repository-binding";
import { repositoryBindingRef } from "@decocms/shared/repository-binding";
import type { RepositoryBinding } from "@decocms/shared/sdk";
import { findOwnedProject } from "./ownership";

/** Why a site can't be delegated, phrased for the operator who has to fix it. */
export type SiteRepositoryResolution =
  | { repositoryId: string }
  | { repositoryId: null; reason: string };

/**
 * The Studio `repositories` row id backing `site`'s GitHub repo, or the reason
 * there is none — the Super Agent needs a repo to check out, and the two ways
 * a site reaches that state need different fixes from the operator.
 *
 * Finds the project the same way ownership does, so a slug linked in
 * `org_sites` resolves to its project rather than only to one whose own slug
 * matches. Then resolves `metadata.repository` the way sandbox start does:
 * the binding's `repositoryId` when it has one, else the organization's
 * repository matching its host and path, since an imported project carries a
 * binding that names no repository row.
 */
export async function resolveSiteRepository(
  ctx: StudioContext,
  organizationId: string,
  site: string,
): Promise<SiteRepositoryResolution> {
  const project = await findOwnedProject(ctx, organizationId, site);
  const binding = (
    project.metadata as { repository?: RepositoryBinding | null } | null
  )?.repository;
  if (!binding) {
    return {
      repositoryId: null,
      reason: `the project for ${site} is not bound to a repository. A project carries its own binding, separate from the organization's linked repositories, and only gets one when it is created from a repository.`,
    };
  }
  const repository = await findRepositoryForBinding(
    ctx.storage,
    organizationId,
    binding,
  );
  if (repository) return { repositoryId: repository.id };
  const ref = repositoryBindingRef(binding);
  return {
    repositoryId: null,
    reason: `${site} is bound to ${ref?.path ?? binding.url}, which this organization has not linked. Link it under Settings → Repositories.`,
  };
}
