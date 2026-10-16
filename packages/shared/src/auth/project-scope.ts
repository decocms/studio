/**
 * Project-scoped role access
 *
 * A custom role can be restricted to a set of projects (Virtual MCPs). The
 * restriction lives in the role's permission map under the reserved `projects`
 * key, read with the permission-list rules (see ./permission-list): `["*"]`
 * grants every project, `["*", "!<id>"]` every project but one, `["<id>"]`
 * only that one, and `[]` none. This mirrors the existing reserved `models`
 * key convention and does NOT require a schema change: the permission map is
 * already free-form JSON.
 *
 * Absence of the key means "no project restriction" (the role sees every
 * project), which keeps every pre-existing role backward compatible.
 *
 * owner/admin bypass all permission checks (see hasAdminRole), so this only
 * ever narrows custom roles — never the built-in owner/admin/user roles.
 */

import {
  listsAllow,
  PERMISSION_WILDCARD,
  type PermissionListFilter,
  permissionListFilter,
} from "./permission-list";

/** Reserved permission-map key holding a role's project scope. */
export const PROJECT_SCOPE_KEY = "projects";

/** Wildcard entry in a project scope meaning "all projects". */
export const PROJECT_SCOPE_WILDCARD = PERMISSION_WILDCARD;

type PermissionMap = Record<string, string[]> | null | undefined;

/**
 * Return a role's project scope, or `null` when the role has no project
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

/** Whether a caller with the given project scope may access `projectId`. */
export function isProjectAllowed(
  scope: string[] | null,
  projectId: string,
): boolean {
  if (scope === null) return true;
  return listsAllow([scope], projectId);
}

/** The projects a scope admits, in a shape a list query can filter on. */
export function projectScopeFilter(
  scope: string[] | null,
): PermissionListFilter {
  return scope === null ? { kind: "all" } : permissionListFilter(scope);
}
