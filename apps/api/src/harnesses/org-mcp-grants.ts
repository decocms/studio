/**
 * Which of the org's MCP connections a run may use, and with which tools.
 *
 * A sandbox run acts on behalf of the person who dispatched it, so it must not
 * reach a connection that person cannot reach. That is not a policy invented
 * here — it is the same decision Studio makes on every proxied tool call
 * (`mcp-clients/outbound/transports/auth.ts` checks
 * `{ <connectionId>: [<toolName>] }`), reproduced at dispatch time so the run's
 * key carries exactly that authority and no more.
 *
 * Reproduced rather than probed: the alternative is one `hasPermission` round
 * trip per (connection, tool) at dispatch, and a probe keyed on `"*"` would
 * throw away a partial grant — a role that may call two tools on a connection
 * would read as "no access" and lose the connection entirely.
 */

import { hasAdminRole } from "@decocms/shared/auth/roles";
import {
  BASIC_USAGE_TOOLS,
  USER_ROLE_TOOLS,
} from "@decocms/shared/tools/registry-metadata";
import type { Permission } from "@/storage/types";

/**
 * The connection entries for a run's key: `{ <connectionId>: [tools] }`, only
 * for connections the dispatcher can actually use.
 *
 * - **admin/owner** bypass every permission check in `AccessControl`, so their
 *   runs get every candidate connection at `"*"`. Anything narrower would be a
 *   restriction the dispatcher does not have.
 * - **everyone else** gets the union of their roles' own statements, verbatim:
 *   a role granting two tools on a connection yields those two tools, and a
 *   connection no role names is absent — which is what the proxy would answer
 *   anyway.
 *
 * A member whose roles grant no connection therefore gets none. That is the
 * honest result, not a bug: today the same person calling that connection
 * through Studio is denied.
 *
 * Pure — the unit test owns this, because the shape of this map is what decides
 * whether a run can call anything at all.
 */
export function connectionGrantsFor(args: {
  /** The dispatcher's `member.role`, possibly Better Auth's comma-joined form. */
  role: string | null | undefined;
  /**
   * Statements for the dispatcher's non-built-in roles, in any order. Built-in
   * roles contribute nothing here: `user` has no per-connection grant (its
   * statement is keyed on `self`), and admin/owner never reach this path.
   */
  roleStatements: readonly Permission[];
  /** Connections the run would otherwise mount. */
  connectionIds: readonly string[];
}): Record<string, string[]> {
  const { role, roleStatements, connectionIds } = args;
  if (hasAdminRole(role ?? undefined)) {
    return Object.fromEntries(connectionIds.map((id) => [id, ["*"]]));
  }
  const grants: Record<string, string[]> = {};
  for (const id of connectionIds) {
    const tools = new Set<string>();
    for (const statement of roleStatements) {
      for (const tool of statement[id] ?? []) tools.add(tool);
    }
    if (tools.size === 0) continue;
    // A `"*"` anywhere in the union subsumes the named tools next to it.
    grants[id] = tools.has("*") ? ["*"] : [...tools];
  }
  return grants;
}

/**
 * The Studio tools (checked under `self`) a run's key may carry: the run-scoped
 * ones as they are, everything else only when the dispatcher could call it
 * themselves — the same answer `AccessControl` gives that member in a session:
 * admin/owner everything, every member the basic-usage set, the built-in
 * `user` role its extra grants, a custom role its own `self` statement.
 *
 * Without this the key would be the escalation: an API key's allowlist is the
 * whole decision for its caller, so a chat run would carry, say,
 * `COLLECTION_VIRTUAL_MCP_DELETE` for a member whose role cannot delete an
 * agent. Pure, so the unit test owns it.
 */
export function selfToolGrantsFor(args: {
  role: string | null | undefined;
  roleStatements: readonly Permission[];
  toolNames: readonly string[];
  /** Tools granted by what the run is, whatever the dispatcher's role. */
  runScoped: ReadonlySet<string>;
}): string[] {
  const { role, roleStatements, toolNames, runScoped } = args;
  if (hasAdminRole(role ?? undefined)) return [...toolNames];
  const isUser = rolesOf(role).includes("user");
  const granted = new Set(roleStatements.flatMap((s) => s.self ?? []));
  return toolNames.filter(
    (tool) =>
      runScoped.has(tool) ||
      BASIC_USAGE_TOOLS.has(tool) ||
      (isUser && USER_ROLE_TOOLS.has(tool)) ||
      granted.has("*") ||
      granted.has(tool),
  );
}

/**
 * The individual roles in a `member.role` value. Better Auth stores multiple
 * roles comma-joined (`"admin,billing-manager"`), and a caller that treats that
 * string as one role name finds no statement for it and silently grants
 * nothing.
 */
export function rolesOf(role: string | null | undefined): string[] {
  return (role ?? "")
    .split(",")
    .map((one) => one.trim())
    .filter(Boolean);
}
