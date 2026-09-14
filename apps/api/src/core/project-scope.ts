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

import { getProjectScope } from "@decocms/shared/auth/project-scope";
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
