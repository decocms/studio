/**
 * Built-in Studio Role Definitions
 *
 * Separated to avoid circular dependencies between auth and context-factory modules.
 */

/**
 * Built-in (non-custom) roles. These have no row in the organizationRole table,
 * so `fetchRolePermissions` returns no stored permissions for them.
 *
 * NOTE: being built-in does NOT mean bypassing permission checks. Only
 * ADMIN_ROLES (owner/admin) bypass; the `user` role is enforced like any
 * member — it receives basic-usage plus its explicit grants and nothing else.
 */
export const BUILTIN_ROLES = ["owner", "admin", "user"] as const;

export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

/**
 * Roles with full org access — they bypass all permission checks at runtime.
 */
export const ADMIN_ROLES: BuiltinRole[] = ["owner", "admin"];

/**
 * True if `role` — a single role OR Better Auth's comma-joined multi-role
 * string (see `parseRoles`) — includes an admin/owner grant. A plain
 * `ADMIN_ROLES.includes(role)` exact-match silently denies a legitimate
 * multi-role owner/admin (e.g. `"admin,billing-manager"`) the runtime bypass,
 * same failure mode already fixed for `canAssignRole`'s caller check.
 */
export function hasAdminRole(role: string | undefined): boolean {
  if (!role) return false;
  const roles = role.split(",");
  return roles.some((r) => (ADMIN_ROLES as readonly string[]).includes(r));
}

/**
 * Validate that the caller's role is allowed to assign the target role(s).
 * Owners can assign any role. Admins can assign "user" or "admin" but NOT
 * "owner" — preventing vertical privilege escalation.
 *
 * `targetRole` may be an array: Better Auth's organization plugin supports
 * multi-role members (stored comma-joined), so every entry must be checked —
 * validating only the first element would let an admin smuggle "owner" in
 * alongside an allowed role (e.g. `["user", "owner"]`).
 *
 * `callerRole` can ALSO be that same comma-joined string (Better Auth's
 * `parseRoles` joins an assigned role array before storing `member.role`), so
 * a multi-role owner/admin — e.g. `"owner,billing-manager"` — must still be
 * recognized. A plain `=== "owner"` check would silently deny them.
 */
export function canAssignRole(
  callerRole: string | undefined,
  targetRole: string | string[],
): boolean {
  const targetRoles = Array.isArray(targetRole) ? targetRole : [targetRole];
  if (targetRoles.length === 0) return false;
  const callerRoles = callerRole ? callerRole.split(",") : [];
  if (callerRoles.includes("owner")) return true;
  if (callerRoles.includes("admin")) {
    return targetRoles.every((r) => r !== "owner");
  }
  return false;
}
