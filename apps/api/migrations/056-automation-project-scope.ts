/**
 * Automation Project Scope Migration
 *
 * Adds `virtual_mcp_id` column to `automations` table so automations can be
 * scoped to a specific project or space (Virtual MCP).
 * NULL means org-level (existing behavior).
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("automations")
    .addColumn("virtual_mcp_id", "text")
    .execute();

  await db.schema
    .createIndex("idx_automations_virtual_mcp")
    .on("automations")
    .columns(["virtual_mcp_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_automations_virtual_mcp").execute();

  await db.schema
    .alterTable("automations")
    .dropColumn("virtual_mcp_id")
    .execute();
}
