/**
 * Adds a deterministic "tool_call" automation kind alongside the existing
 * "agent" kind. Tool-call automations invoke a fixed MCP tool with fixed
 * arguments when their trigger fires — no agent thread, no LLM.
 *
 * Schema changes:
 *   - `kind` discriminator (default 'agent' so existing rows keep their
 *     behavior).
 *   - `virtual_mcp_id` becomes nullable: only required for kind='agent'.
 *   - `connection_id` / `tool_name` / `tool_input` (JSON): only required
 *     for kind='tool_call'.
 *
 * CHECK constraints enforce the per-kind required fields so an inconsistent
 * row can't be written even outside the application layer.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
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

  // tool_input is required too: the workflow uses `tool_input ? JSON.parse(…) : {}`
  // and would happily fire a tool with no arguments on a missing value,
  // which masks misconfigured rows. CREATE/UPDATE already write a JSON
  // string (defaulting to `"{}"`) on every tool_call row, so this is a
  // defense-in-depth invariant rather than a behaviour change.
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

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automations DROP CONSTRAINT chk_automation_tool_call_fields`.execute(
    db,
  );
  await sql`ALTER TABLE automations DROP CONSTRAINT chk_automation_agent_fields`.execute(
    db,
  );
  await sql`ALTER TABLE automations DROP CONSTRAINT chk_automation_kind`.execute(
    db,
  );

  // Restoring NOT NULL requires every row to have a virtual_mcp_id. Any
  // tool_call rows would block this, so the down migration deletes them
  // before re-applying the constraint.
  await sql`DELETE FROM automations WHERE kind = 'tool_call'`.execute(db);
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
