import type { Kysely } from "kysely";

/**
 * Persist the project that owns a task board card.
 *
 * Existing rows stay NULL and use the legacy repository/linked-run inference
 * in the web client. New project-route cards carry the exact virtual MCP id,
 * so two projects that pin the same repository no longer share unrun tasks.
 *
 * There is deliberately no foreign key to `virtual_mcps`: hidden development
 * projects can be replaced or deleted independently. Turning an owned row
 * into NULL via `ON DELETE SET NULL` would make it eligible for legacy
 * repository inference and leak it into a sibling project's board.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("virtual_mcp_id", "text")
    .execute();

  await db.schema
    .createIndex("idx_task_board_items_org_virtual_mcp")
    .on("task_board_items")
    .columns(["organization_id", "virtual_mcp_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropIndex("idx_task_board_items_org_virtual_mcp")
    .ifExists()
    .execute();
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("virtual_mcp_id")
    .execute();
}
