/**
 * Configuration Scopes Utilities
 *
 * Shared utilities for parsing MCP configuration scopes and extracting
 * connection permissions from state.
 *
 * Scope format: "KEY::SCOPE" where:
 * - KEY is a path to a value in configuration state
 * - SCOPE is the permission scope name (e.g., tool name)
 */

import { prop } from "@/tools/connection/json-path";

/**
 * Parse scope string to extract key and scope parts
 * @param scope - Scope string in format "KEY::SCOPE"
 * @returns Tuple of [key, scopeName]
 * @throws Error if scope format is invalid
 */
export function parseScope(scope: string): [string, string] {
  const parts = scope.split("::");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid scope format: ${scope}. Expected format: "KEY::SCOPE"`,
    );
  }
  return parts as [string, string];
}

/**
 * Try to parse scope string, returning null on invalid format instead of throwing
 * @param scope - Scope string in format "KEY::SCOPE"
 * @returns Tuple of [key, scopeName] or null if invalid
 */
function tryParseScope(scope: string): [string, string] | null {
  try {
    return parseScope(scope);
  } catch {
    return null;
  }
}

/**
 * Extract connection ID from a state value
 * State values are expected to be objects with a `value` property containing the connection ID
 *
 * @param stateValue - The value from configuration state
 * @returns The connection ID string, or null if not a valid connection reference
 */
function extractConnectionIdFromStateValue(stateValue: unknown): string | null {
  if (
    typeof stateValue === "object" &&
    stateValue !== null &&
    "value" in stateValue
  ) {
    const connectionIdRef = (stateValue as { value: unknown }).value;
    if (typeof connectionIdRef === "string") {
      return connectionIdRef;
    }
  }
  return null;
}

/**
 * Extract connection permissions from configuration state and scopes
 *
 * Parses scopes in format "KEY::SCOPE" and builds a map of connection IDs to their permitted scopes.
 *
 * @param state - Configuration state object
 * @param scopes - Array of scope strings in format "KEY::SCOPE"
 * @returns Map of connection IDs to arrays of scope names
 */
export function extractConnectionPermissions(
  state: Record<string, unknown> | null | undefined,
  scopes: string[] | null | undefined,
): Record<string, string[]> {
  const permissions: Record<string, string[]> = {};

  if (!state || !scopes) {
    return permissions;
  }

  for (const scope of scopes) {
    if (scope === "*") {
      permissions["*"] = ["*"];
      continue;
    }
    const parsed = tryParseScope(scope);
    if (!parsed) continue;

    const [key, scopeName] = parsed;
    const stateValue = prop(key, state);
    const connectionId = extractConnectionIdFromStateValue(stateValue);

    if (connectionId) {
      if (!permissions[connectionId]) {
        permissions[connectionId] = [];
      }
      permissions[connectionId].push(scopeName);
    }
  }

  return permissions;
}

/**
 * Get all referenced connection IDs from configuration state and scopes
 *
 * @param state - Configuration state object
 * @param scopes - Array of scope strings in format "KEY::SCOPE"
 * @returns Set of referenced connection IDs
 */
export function getReferencedConnectionIds(
  state: Record<string, unknown> | null | undefined,
  scopes: string[] | null | undefined,
): Set<string> {
  const permissions = extractConnectionPermissions(state, scopes);
  return new Set(Object.keys(permissions).filter((id) => id !== "*"));
}
