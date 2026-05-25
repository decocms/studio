/**
 * Backfill GLOBAL_SEARCH into existing custom roles.
 *
 * GLOBAL_SEARCH is the new cross-resource discovery tool added to the
 * basic-usage capability in registry-metadata. Per BASIC_USAGE_TOOLS'
 * contract, every newly-saved custom role bakes the basic-usage tool
 * snapshot into `permission.self`, but roles created before this change
 * are missing GLOBAL_SEARCH and would deny the command palette for any
 * non-admin member assigned to them.
 *
 * Mirrors the 073 backfill pattern. Roles whose `permission.self` is
 * `["*"]` already grant everything and are left untouched.
 *
 * NOTE: The list below is a SNAPSHOT — it must not import the live
 * BASIC_USAGE_TOOLS constant. Migrations are immutable history.
 */

import { type Kysely, sql } from "kysely";

const TOOLS_TO_BACKFILL = ["GLOBAL_SEARCH"];

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
  // No-op: removing GLOBAL_SEARCH from existing roles would silently break
  // the command palette for users currently relying on it.
}
