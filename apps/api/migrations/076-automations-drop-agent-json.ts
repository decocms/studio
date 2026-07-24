/**
 * Drop the redundant `automations.agent` JSON column.
 *
 * Historically the table stored the owning agent in two places:
 *   - `agent` text NOT NULL — JSON `{ id }` (added in 039)
 *   - `virtual_mcp_id` text NULL — added later in 056 to scope automations to
 *     a project/agent for the agent-detail Automations tab.
 *
 * The two fields drifted: AI-created automations sometimes set `agent.id`
 * without `virtual_mcp_id`, so they appeared in the org-level Automations
 * list but disappeared from the agent's tab (which filters strictly by
 * `virtual_mcp_id`).
 *
 * Backfill `virtual_mcp_id` from the JSON, make it NOT NULL, and drop the
 * JSON column. `virtual_mcp_id` is the single source of truth going forward.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE automations
    SET virtual_mcp_id = (agent::json ->> 'id')
    WHERE virtual_mcp_id IS NULL
  `.execute(db);

  await sql`
    ALTER TABLE automations
    ALTER COLUMN virtual_mcp_id SET NOT NULL
  `.execute(db);

  await db.schema.alterTable("automations").dropColumn("agent").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("automations")
    .addColumn("agent", "text")
    .execute();

  await sql`
    UPDATE automations
    SET agent = json_build_object('id', virtual_mcp_id)::text
  `.execute(db);

  await sql`
    ALTER TABLE automations
    ALTER COLUMN agent SET NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE automations
    ALTER COLUMN virtual_mcp_id DROP NOT NULL
  `.execute(db);
}
