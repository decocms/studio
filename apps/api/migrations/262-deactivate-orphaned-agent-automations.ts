import { sql, type Kysely } from "kysely";

/**
 * Turn off automations whose agent was deleted. Agent delete now does this
 * itself; these were left active before it did, and every fire failed with
 * "Agent not found". Only `vir_` ids are real agent rows; synthetic ids such
 * as the Super Agent's never have one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE automations a
    SET active = false, updated_at = ${new Date().toISOString()}
    WHERE a.active = true
      AND a.virtual_mcp_id LIKE 'vir\_%'
      AND NOT EXISTS (
        SELECT 1 FROM connections c WHERE c.id = a.virtual_mcp_id
      )
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
