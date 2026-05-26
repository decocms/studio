/**
 * Removes the `kind = "tool_call"` automation mode introduced by migration
 * 078. Forward-only: every kind='tool_call' row is deleted; the four
 * conditional columns + three CHECK constraints are dropped; `virtual_mcp_id`
 * goes back to NOT NULL.
 *
 * `down()` re-creates the schema shape (columns + constraints) but cannot
 * restore deleted rows.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Constraints first — DROP COLUMN won't drop a CHECK that references it
  // on Postgres before the column itself is gone, and dropping the kind
  // CHECK lets the row delete proceed even if any row ended up with an
  // unknown kind value somehow.
  await sql`ALTER TABLE automations DROP CONSTRAINT chk_automation_tool_call_fields`.execute(
    db,
  );
  await sql`ALTER TABLE automations DROP CONSTRAINT chk_automation_agent_fields`.execute(
    db,
  );
  await sql`ALTER TABLE automations DROP CONSTRAINT chk_automation_kind`.execute(
    db,
  );

  // Drop tool-call rows. Their virtual_mcp_id is NULL by construction,
  // so they would block the NOT NULL restoration below.
  await sql`DELETE FROM automations WHERE kind = 'tool_call'`.execute(db);

  // Restore the pre-078 invariant: agent automations always have an agent.
  await sql`
    ALTER TABLE automations
    ALTER COLUMN virtual_mcp_id SET NOT NULL
  `.execute(db);

  await db.schema
    .alterTable("automations")
    .dropColumn("tool_input")
    .dropColumn("tool_name")
    .dropColumn("connection_id")
    .dropColumn("kind")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Mirror of migration 078's up(). Restores the schema shape only —
  // any tool_call rows deleted by 095's up() are gone for good.
  await db.schema
    .alterTable("automations")
    .addColumn("kind", "text", (col) => col.notNull().defaultTo("agent"))
    .addColumn("connection_id", "text")
    .addColumn("tool_name", "text")
    .addColumn("tool_input", "text")
    .execute();

  await sql`
    ALTER TABLE automations
    ALTER COLUMN virtual_mcp_id DROP NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE automations
    ADD CONSTRAINT chk_automation_kind
    CHECK (kind IN ('agent', 'tool_call'))
  `.execute(db);

  await sql`
    ALTER TABLE automations
    ADD CONSTRAINT chk_automation_agent_fields
    CHECK (kind != 'agent' OR virtual_mcp_id IS NOT NULL)
  `.execute(db);

  await sql`
    ALTER TABLE automations
    ADD CONSTRAINT chk_automation_tool_call_fields
    CHECK (
      kind != 'tool_call'
      OR (
        connection_id IS NOT NULL
        AND tool_name IS NOT NULL
        AND tool_input IS NOT NULL
      )
    )
  `.execute(db);
}
