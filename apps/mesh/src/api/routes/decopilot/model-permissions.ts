/**
 * Model Permissions
 *
 * Utilities for checking model access permissions.
 * Model permissions are stored in the role permission JSON under the "models" key
 * as composite "keyId:modelId" strings (e.g. "aik_abc123:claude-opus-4-5").
 */

import type { Kysely } from "kysely";
import { ADMIN_ROLES } from "@/auth/roles";
import type { Database, Permission } from "@/storage/types";

/**
 * Extract the "models" array from a permission object.
 * Returns undefined if the "models" key is absent (meaning all models are allowed).
 * Returns the array as-is if present (even if empty — empty means "no models allowed").
 */
export function extractModelPermissions(
  permission: Permission | undefined | null,
): string[] | undefined {
  if (!permission) return undefined;
  if (!("models" in permission)) return undefined;
  return permission["models"] ?? undefined;
}

/**
 * Check if a specific API key is accessible at all (i.e. the user has at least
 * one allowed model entry for it). Used to filter AI provider keys.
 *
 * @param models - The "models" array from the permission object, or undefined for "all allowed"
 * @param keyId - The AI provider key ID (e.g. "aik_abc123")
 * @returns true if the key has any allowed models
 */
export function checkKeyPermission(
  models: string[] | undefined,
  keyId: string,
): boolean {
  if (!models) return true;
  if (models.includes("*:*")) return true;
  return models.some((entry) => entry.startsWith(`${keyId}:`));
}

/**
 * Check if a specific model from a specific key is allowed.
 *
 * @param models - The "models" array from the permission object, or undefined for "all allowed"
 * @param keyId - The AI provider key ID (e.g. "aik_abc123")
 * @param modelId - The model ID to check
 * @returns true if the model is allowed
 */
export function checkModelPermission(
  models: string[] | undefined,
  keyId: string,
  modelId: string,
): boolean {
  // No models key = all models allowed (backward compat)
  if (!models) return true;

  return (
    models.includes("*:*") ||
    models.includes(`${keyId}:*`) ||
    models.includes(`${keyId}:${modelId}`)
  );
}

/**
 * Parse the models array into a key-scoped map.
 * Used by the allowed-models API endpoint to return structured data to the client.
 *
 * @returns { allowAll: boolean, models: Record<keyId, modelId[]> }
 */
export function parseModelsToMap(models: string[] | undefined): {
  allowAll: boolean;
  models: Record<string, string[]>;
} {
  if (!models) {
    return { allowAll: true, models: {} };
  }

  if (models.includes("*:*")) {
    return { allowAll: true, models: {} };
  }

  const result: Record<string, string[]> = {};
  for (const entry of models) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx === -1) continue;
    const keyId = entry.slice(0, colonIdx);
    const modelId = entry.slice(colonIdx + 1);
    if (!result[keyId]) {
      result[keyId] = [];
    }
    result[keyId].push(modelId);
  }

  return { allowAll: false, models: result };
}

/**
 * Fetch model permissions for a user's role.
 * Returns undefined for admin/owner roles (they bypass all checks).
 * Returns the "models" array for custom roles.
 * Returns undefined if no "models" key exists (all allowed).
 */
export async function fetchModelPermissions(
  db: Kysely<Database>,
  organizationId: string,
  role: string | undefined,
): Promise<string[] | undefined> {
  // No role or admin/owner = all models allowed
  if (!role || ADMIN_ROLES.includes(role as (typeof ADMIN_ROLES)[number])) {
    return undefined;
  }

  // Query custom role permissions from the organizationRole table
  const roleRecord = await db
    .selectFrom("organizationRole")
    .select(["permission"])
    .where("organizationId", "=", organizationId)
    .where("role", "=", role)
    .executeTakeFirst();

  if (!roleRecord?.permission) {
    return undefined;
  }

  try {
    const permission = JSON.parse(roleRecord.permission) as Permission;
    return extractModelPermissions(permission);
  } catch {
    console.error(
      `[model-permissions] Failed to parse permissions for role: ${role}`,
    );
    // Fail-closed: corrupted permission data should deny access, not grant it.
    // Returning undefined would mean "all models allowed" per the data model.
    return [];
  }
}
