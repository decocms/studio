/**
 * API-key authorization.
 *
 * An API key is authorized SOLELY by its own stored `permissions` allowlist
 * ({ resource: [tools] }) — the owner's org role never widens it. A full-access
 * key carries an explicit wildcard (`{ "*": ["*"] }` or `{ self: ["*"] }`); a
 * key with no allowlist grants nothing (fail-closed). There is intentionally no
 * "default permission" fallback: every key is created with an explicit scope
 * (see API_KEY_CREATE and the internal minters), so "a key without a scope"
 * does not exist.
 */

import type { Permission } from "../storage/types";

/**
 * Does an API key's stored allowlist grant the requested permission?
 *
 * Both are `{ resource: [tools] }` maps. Every (resource, tool) in `requested`
 * must be covered by `granted` — directly, by a per-resource `"*"`, or by a
 * wildcard `"*"` resource (itself optionally `"*"` for all tools). Returns false
 * on the first uncovered entry (fail-closed); an empty/absent allowlist grants
 * nothing.
 */
export function checkApiKeyPermission(
  granted: Permission,
  requested: Permission,
): boolean {
  for (const [resource, tools] of Object.entries(requested)) {
    const grantedTools = granted[resource];

    if (!grantedTools || grantedTools.length === 0) {
      // No grant for this resource — fall back to a wildcard `"*"` resource.
      const wildcardTools = granted["*"];
      if (!wildcardTools || wildcardTools.length === 0) {
        return false;
      }
      if (wildcardTools.includes("*")) {
        continue; // wildcard resource grants every tool
      }
      const wildcardSet = new Set(wildcardTools);
      for (const tool of tools) {
        if (!wildcardSet.has(tool)) return false;
      }
      continue;
    }

    if (grantedTools.includes("*")) {
      continue; // wildcard grants all tools for this resource
    }

    const grantedSet = new Set(grantedTools);
    for (const tool of tools) {
      if (!grantedSet.has(tool)) return false;
    }
  }

  return true;
}
