/**
 * Gateway Tool Selection Mode Migration
 *
 * Splits the old `tool_selection_strategy` column (which held "exclusion" | null for include/exclude logic)
 * into two separate concepts:
 *
 * 1. `tool_selection_mode`: "inclusion" | "exclusion" - controls which tools are included/excluded
 * 2. `tool_selection_strategy`: "passthrough" | "smart_tool_selection" | "code_execution" - gateway behavior (metadata for now)
 *
 * This migration:
 * - Adds new `tool_selection_mode` column
 * - Backfills from old `tool_selection_strategy`: null -> "inclusion", "exclusion" -> "exclusion"
 * - Renames old column to `_old_tool_selection_strategy` (for safety)
 * - Adds new `tool_selection_strategy` column with default "passthrough"
 * - Drops the old column
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Step 1: Add tool_selection_mode column with default
  await db.schema
    .alterTable("gateways")
    .addColumn("tool_selection_mode", "text", (col) =>
      col.notNull().defaultTo("inclusion"),
    )
    .execute();

  // Step 2: Backfill tool_selection_mode from old tool_selection_strategy
  // - "exclusion" -> "exclusion"
  // - null, "null", or anything else -> "inclusion"
  await sql`
    UPDATE gateways
    SET tool_selection_mode = CASE
      WHEN tool_selection_strategy = 'exclusion' THEN 'exclusion'
      ELSE 'inclusion'
    END
  `.execute(db);

  // Step 3: Rename old tool_selection_strategy to a temp name
  // PostgreSQL supports RENAME COLUMN, SQLite 3.25+ also supports it
  await sql`ALTER TABLE gateways RENAME COLUMN tool_selection_strategy TO _old_tool_selection_strategy`.execute(
    db,
  );

  // Step 4: Add new tool_selection_strategy column with new meaning
  await db.schema
    .alterTable("gateways")
    .addColumn("tool_selection_strategy", "text", (col) =>
      col.notNull().defaultTo("passthrough"),
    )
    .execute();

  // Step 5: Drop the old column
  await db.schema
    .alterTable("gateways")
    .dropColumn("_old_tool_selection_strategy")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse the migration:
  // 1. Rename new tool_selection_strategy to temp name
  // 2. Add old tool_selection_strategy column (nullable)
  // 3. Backfill: "inclusion" -> null, "exclusion" -> "exclusion"
  // 4. Drop temp column and tool_selection_mode

  // Step 1: Rename new column to temp
  await sql`ALTER TABLE gateways RENAME COLUMN tool_selection_strategy TO _new_tool_selection_strategy`.execute(
    db,
  );

  // Step 2: Add old-style tool_selection_strategy column (nullable)
  await db.schema
    .alterTable("gateways")
    .addColumn("tool_selection_strategy", "text")
    .execute();

  // Step 3: Backfill from tool_selection_mode
  await sql`
    UPDATE gateways
    SET tool_selection_strategy = CASE
      WHEN tool_selection_mode = 'exclusion' THEN 'exclusion'
      ELSE NULL
    END
  `.execute(db);

  // Step 4: Drop new columns
  await db.schema
    .alterTable("gateways")
    .dropColumn("_new_tool_selection_strategy")
    .execute();

  await db.schema
    .alterTable("gateways")
    .dropColumn("tool_selection_mode")
    .execute();
}
