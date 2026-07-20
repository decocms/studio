/**
 * Built-in Role Definitions
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
 * Validate that the caller's role is allowed to assign the target role(s).
 * Owners can assign any role. Admins can assign "user" or "admin" but NOT
 * "owner" — preventing vertical privilege escalation.
 *
 * `targetRole` may be an array: Better Auth's organization plugin supports
 * multi-role members (stored comma-joined), so every entry must be checked —
 * validating only the first element would let an admin smuggle "owner" in
 * alongside an allowed role (e.g. `["user", "owner"]`).
 */
export function canAssignRole(
  callerRole: string | undefined,
  targetRole: string | string[],
): boolean {
  const targetRoles = Array.isArray(targetRole) ? targetRole : [targetRole];
  if (targetRoles.length === 0) return false;
  if (callerRole === "owner") return true;
  if (callerRole === "admin") return targetRoles.every((r) => r !== "owner");
  return false;
}
