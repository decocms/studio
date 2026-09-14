/**
 * Project-scoped role access
 *
 * A custom role can be restricted to a specific set of projects (pinned
 * Virtual MCPs). The restriction lives in the role's permission map under the
 * reserved `projects` key — an allowlist of project (Virtual MCP) connection
 * ids. This mirrors the existing reserved `models` key convention and does NOT
 * require a schema change: the permission map is already free-form JSON.
 *
 * Absence of the key means "no project restriction" (the role sees every
 * project), which keeps every pre-existing role backward compatible. Presence
 * means the role is scoped to exactly the listed ids; `["*"]` explicitly grants
 * all projects, and `[]` grants none.
 *
 * owner/admin bypass all permission checks (see hasAdminRole), so this only
 * ever narrows custom roles — never the built-in owner/admin/user roles.
 */

/** Reserved permission-map key holding a role's project allowlist. */
export const PROJECT_SCOPE_KEY = "projects";

/** Wildcard entry in a project allowlist meaning "all projects". */
export const PROJECT_SCOPE_WILDCARD = "*";

type PermissionMap = Record<string, string[]> | null | undefined;

/**
 * Return a role's project allowlist, or `null` when the role has no project
 * restriction at all (unrestricted — sees every project).
 *
 * A `null` return is semantically different from `[]`: `null` = unrestricted,
 * `[]` = restricted to zero projects.
 */
export function getProjectScope(permission: PermissionMap): string[] | null {
  if (!permission) return null;
  const scope = permission[PROJECT_SCOPE_KEY];
  return Array.isArray(scope) ? scope : null;
}

/**
 * Whether a caller with the given project scope may access `projectId`.
 *
 * `scope === null` (unrestricted) always allows. A `*` entry allows any
 * project. Otherwise the id must be explicitly listed.
 */
export function isProjectAllowed(
  scope: string[] | null,
  projectId: string,
): boolean {
  if (scope === null) return true;
  if (scope.includes(PROJECT_SCOPE_WILDCARD)) return true;
  return scope.includes(projectId);
}
