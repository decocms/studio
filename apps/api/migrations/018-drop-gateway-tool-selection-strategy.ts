/**
 * Drop Gateway Tool Selection Strategy Migration
 *
 * Removes the `tool_selection_strategy` column from the `gateways` table.
 * Strategy is now determined at request time from the `?mode=` query parameter
 * instead of being persisted. Default behavior is "passthrough".
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("gateways")
    .dropColumn("tool_selection_strategy")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Re-add the column with default "passthrough" to match new behavior
  await db.schema
    .alterTable("gateways")
    .addColumn("tool_selection_strategy", "text", (col) =>
      col.notNull().defaultTo("passthrough"),
    )
    .execute();
}
