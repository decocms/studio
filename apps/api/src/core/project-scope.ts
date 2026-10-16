/**
 * Resolve the project (Virtual MCP) allowlist for the current caller.
 *
 * A custom role may be scoped to a set of projects via the reserved `projects`
 * key in its stored permission map (see @decocms/shared/auth/project-scope).
 * This resolves that allowlist for the caller so read/list tools can hide, and
 * mutation tools can reject, projects outside it.
 *
 * Returns `null` (unrestricted — sees every project) for:
 *   - owner/admin (they bypass all permission checks anyway),
 *   - built-in roles (owner/admin/user have no organizationRole row),
 *   - API-key principals (authorized by their own allowlist, a separate lane),
 *   - any role whose stored permission omits the `projects` key.
 */

import {
  getProjectScope,
  projectScopeFilter,
} from "@decocms/shared/auth/project-scope";
import { isScopableProject } from "@decocms/shared/sdk";
import { hasAdminRole } from "@decocms/shared/auth/roles";
import { fetchRolePermissions } from "./context-factory";
import type { StudioContext } from "./studio-context";

export async function resolveCallerProjectScope(
  ctx: StudioContext,
): Promise<string[] | null> {
  // API keys are authorized by their own allowlist, not a member role.
  if (ctx.auth.apiKey) {
    return null;
  }

  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    return null;
  }

  // Path-resolved role matches the targeted org; fall back to the session role.
  const role =
    ctx.access.getRole() ?? ctx.organization?.role ?? ctx.auth.user?.role;
  if (!role || hasAdminRole(role)) {
    return null;
  }

  // Reuse the map already resolved at auth time when it's for this org (no requery).
  if (
    ctx.auth.permissions &&
    ctx.auth.permissionsOrganizationId === organizationId
  ) {
    return getProjectScope(ctx.auth.permissions);
  }

  // Built-in roles have no organizationRole row → undefined → unrestricted.
  const permission = await fetchRolePermissions(ctx.db, organizationId, role);
  return getProjectScope(permission);
}

const NO_HIDDEN_PROJECTS: ReadonlySet<string> = new Set();

/**
 * The org's projects the caller may not see. Lists filter on this rather than
 * on the scope itself, so things filed under an agent that is not a project
 * (or under nothing) stay visible to a role scoped to a few projects.
 */
export async function resolveHiddenProjectIds(
  ctx: StudioContext,
): Promise<ReadonlySet<string>> {
  const filter = projectScopeFilter(await resolveCallerProjectScope(ctx));
  if (filter.kind === "all") return NO_HIDDEN_PROJECTS;
  if (filter.kind === "except") return new Set(filter.names);

  const organizationId = ctx.organization?.id;
  if (!organizationId) return NO_HIDDEN_PROJECTS;
  const allowed = new Set(filter.names);
  const projects = await ctx.storage.virtualMcps.list(organizationId);
  return new Set(
    projects
      .filter((project) => isScopableProject(project))
      .map((project) => project.id)
      .filter((id) => !allowed.has(id)),
  );
}

/** Whether something filed under `projectId` (or nothing) is visible. */
export function isFiledUnderVisibleProject(
  hidden: ReadonlySet<string>,
  projectId: string | null | undefined,
): boolean {
  return !projectId || !hidden.has(projectId);
}
