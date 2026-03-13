/**
 * Drop tool_approval_level from automations
 *
 * Automations always run with "yolo" tool approval, so the column is unnecessary.
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automations DROP CONSTRAINT IF EXISTS chk_tool_approval_level`.execute(
    db,
  );
  await db.schema
    .alterTable("automations")
    .dropColumn("tool_approval_level")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("automations")
    .addColumn("tool_approval_level", "text", (col) =>
      col.notNull().defaultTo("yolo"),
    )
    .execute();
  await sql`ALTER TABLE automations ADD CONSTRAINT chk_tool_approval_level CHECK (tool_approval_level IN ('none', 'readonly', 'yolo'))`.execute(
    db,
  );
}
