/**
 * Permission-map authorization.
 *
 * An API key is authorized SOLELY by its own stored `permissions` allowlist
 * ({ resource: [tools] }) — the owner's org role never widens it. A full-access
 * key carries an explicit wildcard (`{ "*": ["*"] }` or `{ self: ["*"] }`); a
 * key with no allowlist grants nothing (fail-closed). There is intentionally no
 * "default permission" fallback: every key is created with an explicit scope
 * (see API_KEY_CREATE and the internal minters), so "a key without a scope"
 * does not exist.
 *
 * Custom role statements are read with the same rules, less the `"*"`
 * resource (see `checkRolePermission`).
 */

import { CONNECTION_SCOPE_KEY } from "@decocms/shared/auth/connection-scope";
import {
  listDenies,
  listGrants,
  listsAllow,
} from "@decocms/shared/auth/permission-list";
import type { Permission } from "../storage/types";

const WILDCARD_RESOURCE = "*";

/**
 * Does a stored permission map grant the requested permission?
 *
 * Both are `{ resource: [tools] }` maps. Every (resource, tool) in `requested`
 * must be allowed by the resource's own list or the wildcard `"*"` resource,
 * read together with the permission-list rules (`*` grants all, `!tool` and
 * `!*` deny, a denial wins). For a connection resource (anything but `self`)
 * the reserved `connections` list can also grant or deny the whole
 * connection, and its denial wins over both lists. Returns false on the first
 * uncovered entry (fail-closed); an empty/absent map grants nothing.
 */
export function checkApiKeyPermission(
  granted: Permission,
  requested: Permission,
): boolean {
  for (const [resource, tools] of Object.entries(requested)) {
    const lists = [granted[resource], granted[WILDCARD_RESOURCE]];
    const connectionScope =
      resource === "self" ? undefined : granted[CONNECTION_SCOPE_KEY];
    if (listDenies(connectionScope, resource)) return false;
    const wholeConnection = listGrants(connectionScope, resource);

    for (const tool of tools) {
      if (wholeConnection) {
        if (lists.some((list) => listDenies(list, tool))) return false;
        continue;
      }
      if (!listsAllow(lists, tool)) return false;
    }
  }

  return true;
}

/**
 * Does a role statement grant the requested permission? The same rules as a
 * key, except that a `"*"` resource key grants nothing: Better Auth, which
 * evaluated custom roles before deny entries existed, only matched it for a
 * resource literally named `"*"`, so honoring it would widen stored roles.
 */
export function checkRolePermission(
  statement: Permission,
  requested: Permission,
): boolean {
  const { [WILDCARD_RESOURCE]: _anyResource, ...ownResources } = statement;
  return checkApiKeyPermission(ownResources, requested);
}
