import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import type { RepositoryBinding } from "@decocms/shared/sdk/types";
import { resolveCallerProjectScope } from "@/core/project-scope";
import type { StudioContext } from "@/core/studio-context";

/**
 * The project a card is being stamped with, once it is known to be this org's
 * and within the caller's project scope. Anything else reads as not found, so
 * an id never confirms another tenant's project.
 */
export async function resolveCardProject(
  ctx: StudioContext,
  organizationId: string,
  virtualMcpId: string,
): Promise<{ id: string; repository: RepositoryBinding | null }> {
  const project = await ctx.storage.virtualMcps.findById(
    virtualMcpId,
    organizationId,
  );
  const allowed =
    project?.organization_id === organizationId &&
    isProjectAllowed(await resolveCallerProjectScope(ctx), virtualMcpId);
  if (!project || !allowed) {
    throw new Error(`Project not found: ${virtualMcpId}`);
  }
  return { id: project.id, repository: project.metadata?.repository ?? null };
}

/**
 * The checkout fields to write alongside a card's `repo` edit.
 *
 * A project stamp with no `repo` takes the project's repository, so a card
 * filed for a project can run without naming one. `repositoryId` follows the
 * name: kept from the project only when the name is the project's, otherwise
 * cleared, because dispatch binds by id before name and a stale id would check
 * out the repository the card no longer names.
 *
 * Returns `{}` when neither field is touched — an update that leaves both
 * alone must not write them.
 */
export function cardCheckout(params: {
  /** The resolved project being stamped, or undefined when the project is not changing. */
  project: { repository: RepositoryBinding | null } | undefined;
  /** The `repo` the caller passed; undefined when absent. */
  repo: string | null | undefined;
  /** The card's current `repo`, on an update. */
  previousRepo?: string | null;
}): { repo?: string | null; repositoryId?: string | null } {
  const { project, repo, previousRepo } = params;
  const binding = project?.repository ?? null;
  const projectRepo = binding ? `${binding.owner}/${binding.name}` : null;

  if (project && repo === undefined) {
    return { repo: projectRepo, repositoryId: binding?.repositoryId ?? null };
  }
  if (repo === undefined) return {};
  if (projectRepo && sameRepo(repo, projectRepo)) {
    return { repo, repositoryId: binding?.repositoryId ?? null };
  }
  if (previousRepo !== undefined && sameRepo(repo, previousRepo)) {
    return { repo };
  }
  return { repo, repositoryId: null };
}

function sameRepo(a: string | null, b: string | null): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}
