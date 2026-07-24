/**
 * Thread Virtual MCP ID Migration
 *
 * Replaces the `agent_ids` JSON text column with a simple `virtual_mcp_id`
 * foreign key. Each thread is associated with exactly one virtual MCP
 * (the agent it was initiated with).
 *
 * - Adds `virtual_mcp_id` column (NOT NULL, defaults to empty string)
 * - Backfills from `agent_ids[0]` where available
 * - Adds composite index for efficient querying
 * - Drops `agent_ids` column
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("virtual_mcp_id", "text", (col) => col.notNull().defaultTo(""))
    .execute();

  await sql`
    UPDATE threads
    SET virtual_mcp_id = (agent_ids::jsonb ->> 0)
    WHERE agent_ids IS NOT NULL
      AND agent_ids != '[]'
      AND agent_ids != ''
      AND (agent_ids::jsonb ->> 0) IS NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX idx_threads_virtual_mcp_id
    ON threads (organization_id, virtual_mcp_id, hidden, updated_at DESC)
  `.execute(db);

  await db.schema.alterTable("threads").dropColumn("agent_ids").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("agent_ids", "text", (col) => col.defaultTo("[]"))
    .execute();

  await sql`
    UPDATE threads
    SET agent_ids = CASE
      WHEN virtual_mcp_id IS NOT NULL AND virtual_mcp_id != ''
      THEN jsonb_build_array(virtual_mcp_id)::text
      ELSE '[]'
    END
  `.execute(db);

  await sql`DROP INDEX IF EXISTS idx_threads_virtual_mcp_id`.execute(db);

  await db.schema.alterTable("threads").dropColumn("virtual_mcp_id").execute();
}
