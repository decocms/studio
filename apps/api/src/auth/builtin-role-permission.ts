/**
 * In-memory permission resolution for BUILT-IN roles (Flow 2, browser sessions).
 *
 * WHY THIS EXISTS
 * ---------------
 * Per non-admin browser request, `createBoundAuthClient.hasPermission` makes TWO
 * sequential DB-backed Better Auth `hasPermission` calls (an exact probe
 * `{resource:[tool]}` then a wildcard probe `{resource:["*"]}`). Each call =
 * session validation + `member` findOne + `organizationRole` findMany + SQL
 * compile, all synchronous on the main thread. On big orgs this dominated
 * ~40ms event-loop hitches.
 *
 * By the time control reaches Flow 2, the member's `role` for the EFFECTIVE org
 * has already been resolved this request (a fresh `member` read in
 * `authenticateRequest`). For BUILT-IN roles (`user`/`admin`/`owner`), the
 * role → statement mapping is STATIC CODE (compiled into the app via
 * `auth/index.ts`), not data. Resolving them in-memory therefore adds ZERO new
 * staleness risk over the existing flow: the role assignment is the only fresh
 * input, and we already have it.
 *
 * PARITY WITH BETTER AUTH (verified against installed @decocms/better-auth@1.5.x)
 * -----------------------------------------------------------------------------
 * Better Auth's `authorize(request)` (access.mjs `role()`) matches actions
 * LITERALLY: `allowedActions.includes(action)`, no wildcard expansion; a
 * missing resource key denies. The org-plugin `hasPermissionFn`
 * (permission.mjs) splits `member.role` on "," and ORs each role's
 * `authorize()`. The `/organization/has-permission` endpoint resolves the
 * member's role for `organizationId ?? session.activeOrganizationId` — the
 * SAME effective org we key on here.
 *
 * The current two-probe flow is exactly: `authorize({key:[resource]}).success
 * || authorize({key:["*"]}).success`. For a single built-in role with a static
 * statement S, that reduces to `S[key]?.includes(resource) ||
 * S[key]?.includes("*")` — which is what `matchStatement` computes. This is the
 * same wildcard logic as `checkApiKeyPermission`.
 *
 * FALL-BACK (fail-safe to existing behavior)
 * ------------------------------------------
 * Anything that is NOT a single, known built-in role returns "fallback":
 *   - custom/dynamic roles (rows in `organizationRole`) — role → statement is
 *     DATA merged at runtime by `getOrganizationStatements`; not resolvable here
 *   - comma-joined multi-role strings — the OR-over-roles may include a custom
 *     role whose statement we don't have
 *   - any unexpected/empty role
 * The caller then runs the unchanged two-call Better Auth path.
 *
 * NOTE: `admin`/`owner` bypass BEFORE Flow 2 (in both `createBoundAuthClient`
 * and `AccessControl.checkResource`), so in practice only `user` reaches here.
 * They are still encoded correctly for robustness and self-documentation.
 */

import type { Permission } from "@/storage/types";
import {
  adminAc,
  memberAc,
} from "@decocms/better-auth/plugins/organization/access";
import {
  getToolsByCategory,
  USER_ROLE_TOOLS,
} from "@decocms/shared/tools/registry-metadata";
import { BUILTIN_ROLES } from "@decocms/shared/auth/roles";

/**
 * Build the STATIC statements for the built-in roles, mirroring the role
 * construction in `auth/index.ts` EXACTLY (single source of truth: this
 * function is what `auth/index.ts` consumes to build its org-plugin roles, so
 * the two cannot drift).
 *
 * - `user`: `{ self: [...USER_ROLE_TOOLS], ...memberAc.statements }`
 * - `admin`/`owner`: `{ self: ["*", ...allTools], ...adminAc.statements }`
 *
 * `allTools` is injected (not imported) because enumerating it requires the
 * tool registry; the only consumer that needs the admin/owner `self` list is
 * `auth/index.ts`, which already has it. Flow 2 only ever resolves `user`
 * (admin/owner bypass earlier), but encoding all three keeps this in lock-step
 * with the auth config.
 */
export function getBuiltinRoleStatements(
  allTools: string[],
): Record<string, Permission> {
  const creatorSelf = ["*", ...allTools];
  return {
    user: {
      self: [...USER_ROLE_TOOLS],
      ...memberAc.statements,
    },
    admin: {
      self: creatorSelf,
      ...adminAc.statements,
    },
    owner: {
      self: creatorSelf,
      ...adminAc.statements,
    },
  };
}

/**
 * The decision for a single permission check.
 * - "grant": the in-memory built-in statement authorizes the request
 * - "deny": the in-memory built-in statement denies the request
 * - "fallback": cannot be resolved in-memory; caller MUST use Better Auth
 */
export type BuiltinPermissionDecision = "grant" | "deny" | "fallback";

/**
 * Mirror of Better Auth's `role().authorize()` for ONE resource/action set,
 * with the OR-wildcard fallback the current two-probe flow performs.
 *
 * For every (resource, actions) pair in `requested`, the statement must grant
 * EVERY action — either the literal action, or "*" (the wildcard probe the
 * existing code issues as a second call). A resource key missing from the
 * statement denies, exactly like Better Auth (`if (!allowedActions) return
 * {success:false}`).
 */
export function matchStatement(
  statement: Permission,
  requested: Permission,
): boolean {
  for (const [resource, actions] of Object.entries(requested)) {
    const allowed = statement[resource];
    if (!allowed) return false;
    for (const action of actions) {
      if (!allowed.includes(action) && !allowed.includes("*")) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Resolve a permission check against built-in roles entirely in-memory.
 *
 * @param role             the caller's `member.role` for the effective org
 * @param requested        the permission being checked, e.g. `{ self: [tool] }`
 * @param builtinStatements role-name → static statement, built once from the
 *                          in-code role definitions (see
 *                          `getBuiltinRoleStatements`)
 *
 * Returns "fallback" for ANY role that is not a single known built-in role.
 */
export function resolveBuiltinRolePermission(
  role: string | undefined,
  requested: Permission,
  builtinStatements: Record<string, Permission>,
): BuiltinPermissionDecision {
  if (!role) return "fallback";

  // Comma-joined multi-role: the OR may include a custom role whose statement
  // we don't have in-memory. Fall back unconditionally — never partially
  // resolve a multi-role string.
  if (role.includes(",")) return "fallback";

  // Only single, known built-in roles are resolvable from static code.
  if (!BUILTIN_ROLES.includes(role as (typeof BUILTIN_ROLES)[number])) {
    return "fallback";
  }

  const statement = builtinStatements[role];
  if (!statement) return "fallback";

  return matchStatement(statement, requested) ? "grant" : "deny";
}

/**
 * Process-lifetime singleton of the built-in role statements, built once from
 * the tool registry. The registry is static after module load, so this never
 * changes during a process. `createBoundAuthClient` reads it on the Flow 2 hot
 * path without recomputing per request.
 *
 * Same builder as `auth/index.ts` → identical statements (no drift).
 */
let cachedStatements: Record<string, Permission> | undefined;

export function getCachedBuiltinRoleStatements(): Record<string, Permission> {
  if (!cachedStatements) {
    const allTools = Object.values(getToolsByCategory()).flatMap((tools) =>
      tools.map((t) => t.name),
    );
    cachedStatements = getBuiltinRoleStatements(allTools);
  }
  return cachedStatements;
}
