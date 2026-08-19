import { type Kysely, sql } from "kysely";

/**
 * Env vars every task-board run gets, org-wide.
 *
 * A board run is dispatched by the board, not by a person opening an agent, so
 * there is no virtual MCP whose `metadata.runtime.env` it could inherit — its
 * `virtual_mcp_id` is the synthetic Decopilot id, which has no row. Until now a
 * board run's pod therefore booted with nothing but its model credential, and
 * an org whose tests need `SOME_API_KEY` had no way to hand it over.
 *
 * Secret references only, never inline values: `ORGANIZATION_SETTINGS_GET` is
 * read by every member on shell load, so a literal here would ship the value to
 * every browser in the org. Each entry names a vault secret, resolved at
 * dispatch.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE organization_settings
      ADD COLUMN task_board_env jsonb
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE organization_settings
      DROP COLUMN task_board_env
  `.execute(db);
}
