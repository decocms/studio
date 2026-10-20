/**
 * Resolve the project (Virtual MCP) allowlist for the current caller.
 *
 * A custom role may be scoped to a set of projects via the reserved `projects`
 * key in its stored permission map (see @decocms/shared/auth/project-scope).
 * This resolves that allowlist for the caller so read/list tools can hide, and
 * mutation tools can reject, projects outside it.
 *
 * A member with several roles sees the projects any of them admits.
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
  unionProjectScopes,
} from "@decocms/shared/auth/project-scope";
import { isScopableProject } from "@decocms/shared/sdk";
import { hasAdminRole, rolesOf } from "@decocms/shared/auth/roles";
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
  const scopes = await Promise.all(
    rolesOf(role).map(async (one) =>
      getProjectScope(await fetchRolePermissions(ctx.db, organizationId, one)),
    ),
  );
  return unionProjectScopes(scopes);
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

/** The fields the board attributes a card to a project by. */
interface ProjectAttributedCard {
  virtualMcpId: string | null;
  repo: string | null;
  threads: readonly { virtualMcpId: string | null }[];
}

/**
 * Whether a card is visible when `hidden` projects are not. The board
 * attributes a card to a project by its stamp, a linked thread, or a project
 * id older clients wrote into `repo`, so any of them naming a hidden project
 * hides the card.
 */
export function isCardInVisibleProject(
  hidden: ReadonlySet<string>,
  card: ProjectAttributedCard,
): boolean {
  if (hidden.size === 0) return true;
  const named = [
    card.virtualMcpId,
    card.repo?.trim(),
    ...card.threads.map((thread) => thread.virtualMcpId),
  ];
  return !named.some((id) => id && hidden.has(id));
}
