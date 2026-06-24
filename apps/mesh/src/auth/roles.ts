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
 * Validate that the caller's role is allowed to assign the target role.
 * Owners can assign any role. Admins can assign "user" or "admin" but NOT
 * "owner" — preventing vertical privilege escalation.
 */
export function canAssignRole(
  callerRole: string | undefined,
  targetRole: string,
): boolean {
  if (callerRole === "owner") return true;
  if (callerRole === "admin") return targetRole !== "owner";
  return false;
}

/**
 * Validate that the caller's role is allowed to create/update API keys with
 * the requested permissions. Owners and admins can grant any permissions
 * (they bypass all checks at runtime anyway). Regular users cannot grant
 * wildcard ("*") permissions — they may only grant specific tool names
 * they themselves hold.
 */
export function validateApiKeyPermissions(
  callerRole: string | undefined,
  permissions: Record<string, string[]> | undefined,
): void {
  if (!permissions) return;
  // Owners and admins bypass — they already have full access at runtime
  if (callerRole === "owner" || callerRole === "admin") return;

  for (const [resource, actions] of Object.entries(permissions)) {
    if (actions.includes("*")) {
      throw new Error(
        `Insufficient privileges to grant wildcard permissions on "${resource}". Only admins and owners can create wildcard API keys.`,
      );
    }
  }
}
