import type { StudioContext } from "../../core/studio-context";
import { findRepositoryForBinding } from "@/git-providers/repository-binding";
import type { RepositoryBinding } from "@decocms/shared/sdk";
import type { RepositoryRecord } from "@/storage/repositories";
import { findOwnedProject } from "./ownership";

/**
 * The Studio `repositories` row backing an already-resolved project's
 * GitHub repo, or `null` when the project has no linked repository yet (e.g.
 * a project not connected to GitHub) — a site in that state simply can't be
 * delegated to the Super Agent, which needs a repo to check out.
 *
 * Resolves `metadata.repository` the way sandbox start does: the binding's
 * `repositoryId` when it has one, else the organization's repository
 * matching its host and path, since an imported project carries a binding
 * that names no repository row.
 */
export async function resolveRepositoryForProject(
  ctx: StudioContext,
  organizationId: string,
  project: { metadata: unknown },
): Promise<RepositoryRecord | null> {
  const binding = (
    project.metadata as { repository?: RepositoryBinding | null } | null
  )?.repository;
  if (!binding) return null;
  return findRepositoryForBinding(ctx.storage, organizationId, binding);
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
  const repository = await resolveRepositoryForProject(
    ctx,
    organizationId,
    project,
  );
  return repository?.id ?? null;
}
