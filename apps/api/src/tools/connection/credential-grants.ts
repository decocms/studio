import {
  getReferencedConnectionIds,
  parseScope,
} from "@/auth/configuration-scopes";
import {
  CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
  CREDENTIAL_CONFIGURATION_READ_SCOPE,
} from "@/storage/connection-credential-vault";
import type { StudioContext } from "../../core/studio-context";
import { prop } from "./json-path";

const CREDENTIAL_READ_SCOPES = new Set<string>([
  CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
  CREDENTIAL_CONFIGURATION_READ_SCOPE,
]);

/**
 * Inject the well-known "SELF" sentinel into state when any SELF:: scopes are
 * present and the key hasn't already been set. The sentinel value resolves to
 * the org's own self-endpoint, bypassing the normal DB-existence check inside
 * validateConfiguration (see the `endsWith("_self")` guard there).
 */
export function injectSelfSentinel(
  state: Record<string, unknown>,
  scopes: string[],
  organizationId: string,
): void {
  if (
    scopes.some((s) => s !== "*" && s.startsWith("SELF::")) &&
    state["SELF"] === undefined
  ) {
    state["SELF"] = { value: `${organizationId}_self` };
  }
}

export function deriveCredentialGrants(
  state: Record<string, unknown>,
  scopes: string[],
): Array<{ targetConnectionId: string; scope: string }> {
  const grants = new Map<
    string,
    { targetConnectionId: string; scope: string }
  >();

  for (const scope of scopes) {
    if (scope === "*") {
      continue;
    }

    const [key, scopeName] = parseScope(scope);
    if (!CREDENTIAL_READ_SCOPES.has(scopeName)) {
      continue;
    }

    const stateValue = prop(key, state);
    if (
      typeof stateValue !== "object" ||
      stateValue === null ||
      !("value" in stateValue)
    ) {
      continue;
    }

    const targetConnectionId = (stateValue as { value: unknown }).value;
    if (typeof targetConnectionId !== "string") {
      continue;
    }

    grants.set(`${targetConnectionId}:${scopeName}`, {
      targetConnectionId,
      scope: scopeName,
    });
  }

  return [...grants.values()];
}

/**
 * Validate configuration state and scopes, checking referenced connections.
 */
export async function validateConfiguration(
  state: Record<string, unknown>,
  scopes: string[],
  organizationId: string,
  ctx: StudioContext,
): Promise<void> {
  // Validate scope format and state keys.
  for (const scope of scopes) {
    // Parse scope format: "KEY::SCOPE" (throws on invalid format).
    if (scope === "*") {
      continue;
    }
    const [key] = parseScope(scope);
    const value = prop(key, state);

    if (value === undefined || value === null) {
      throw new Error(
        `Scope references key "${key}" but it's not present in state`,
      );
    }
  }

  const referencedConnections = getReferencedConnectionIds(state, scopes);
  const selfConnectionId = `${organizationId}_self`;

  for (const refConnectionId of referencedConnections) {
    // Only the caller's own self-connection skips the ownership/access checks below.
    if (refConnectionId === selfConnectionId) {
      continue;
    }

    const refConnection =
      await ctx.storage.connections.findById(refConnectionId);
    if (!refConnection || refConnection.organization_id !== organizationId) {
      throw new Error(`Referenced connection not found: ${refConnectionId}`);
    }

    try {
      await ctx.access.check(refConnectionId);
    } catch (error) {
      throw new Error(
        `Access denied to referenced connection: ${refConnectionId}. ${
          (error as Error).message
        }`,
      );
    }
  }
}
