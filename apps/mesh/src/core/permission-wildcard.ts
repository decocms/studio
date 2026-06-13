import type { Permission } from "../storage/types";

/**
 * Better Auth's access-control `authorize()` matches requested actions
 * LITERALLY against a role's stored statement
 * (`allowedActions.includes(requestedAction)` — see
 * `@decocms/better-auth` `dist/access-*.mjs`, `function role()`). It performs
 * NO wildcard expansion: a request for `{ self: ["SOME_TOOL"] }` matches only a
 * role whose `self` statement literally contains `"SOME_TOOL"`, and a request
 * for `{ self: ["*"] }` matches only a role whose `self` literally contains
 * `"*"`. The two are disjoint OR-branches.
 *
 * Because the wildcard lives on the role-statement side, the only way to grant
 * "this member holds a `*` on this resource" through Better Auth's
 * `hasPermission` endpoint is to probe for the literal `"*"` action. This
 * builder turns an exact permission request (`{ resource: [tool] }`) into its
 * wildcard counterpart (`{ resource: ["*"] }`) for that second probe.
 *
 * It must stay a SEPARATE probe from the exact one: a single merged array
 * `{ resource: [tool, "*"] }` would be AND-matched by `authorize`
 * (`requestedActions.every(...)`) and therefore fail for both an exact-only and
 * a wildcard-only role — denying access that should be granted. See
 * `permission-wildcard.test.ts`.
 */
export function buildWildcardPermission(
  requestedPermission: Permission,
): Permission {
  const wildcardPermission: Permission = {};
  for (const resource of Object.keys(requestedPermission)) {
    wildcardPermission[resource] = ["*"];
  }
  return wildcardPermission;
}
