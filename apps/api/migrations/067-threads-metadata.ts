/**
 * Migration 067: Add metadata column to threads
 *
 * Adds a jsonb metadata column used to persist per-task UI state
 * (e.g., expanded_tools for the unified chat layout's right-panel tabs).
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("metadata", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("metadata").execute();
}
