/**
 * Backfill basic-usage tools into existing custom roles.
 *
 * The role editor now bakes BASIC_USAGE_TOOLS (defined in registry-metadata)
 * into the saved `permission.self` array of every custom role at submit time.
 * Roles created before this change are missing those tools and would lose
 * access until someone re-saves them via the UI.
 *
 * This migration adds the snapshot of tools below to every custom role's
 * `permission.self` array. Roles with `permission.self === ["*"]` already
 * grant everything and are left untouched.
 *
 * NOTE: The list below is a SNAPSHOT — it must not import the live
 * BASIC_USAGE_TOOLS constant. Migrations are immutable history. If
 * BASIC_USAGE_TOOLS changes in the future, write a new migration with the
 * tools added since this one.
 */

import { type Kysely, sql } from "kysely";

const TOOLS_TO_BACKFILL = [
  "COLLECTION_CONNECTIONS_LIST",
  "COLLECTION_CONNECTIONS_GET",
  "CONNECTION_TEST",
  "COLLECTION_VIRTUAL_MCP_LIST",
  "COLLECTION_VIRTUAL_MCP_GET",
  "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
  "AUTOMATION_GET",
  "AUTOMATION_LIST",
  "AI_PROVIDERS_LIST",
  "AI_PROVIDERS_LIST_MODELS",
  "AI_PROVIDERS_ACTIVE",
  "LIST_OBJECTS",
  "GET_OBJECT_METADATA",
  "GET_PRESIGNED_URL",
  "PUT_PRESIGNED_URL",
  "VM_START",
  "VM_DELETE",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ id: string; permission: string | null }>`
    SELECT id, permission FROM "organizationRole"
  `.execute(db);

  for (const row of result.rows) {
    if (!row.permission) continue;

    let perm: Record<string, unknown>;
    try {
      perm = JSON.parse(row.permission);
    } catch {
      continue;
    }

    const self = perm.self;
    if (!Array.isArray(self)) continue;
    if (self.length === 1 && self[0] === "*") continue;

    const existing = self as string[];
    const merged = Array.from(new Set([...existing, ...TOOLS_TO_BACKFILL]));
    if (merged.length === existing.length) continue;

    perm.self = merged;
    const updated = JSON.stringify(perm);

    await sql`
      UPDATE "organizationRole"
      SET permission = ${updated}
      WHERE id = ${row.id}
    `.execute(db);
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No-op: removing basic-usage tools from existing roles would break
  // access for users currently relying on them.
}
