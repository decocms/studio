/**
 * Rename "CMS MCP" to "Deco CMS" and Reset Tools Cache
 *
 * The Deco CMS connection exposes the Deco CMS APIs via MCP.
 *
 * This migration:
 * 1. Renames its title from "CMS MCP" to "Deco CMS" to align with the
 *    Deco CMS rebranding.
 * 2. Resets the `tools` column to NULL so the tool cache is regenerated
 *    on next request.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE connections
    SET title = 'Deco CMS',
        tools = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE app_name = '@deco/management-mcp'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE connections
    SET title = 'CMS MCP',
        updated_at = CURRENT_TIMESTAMP
    WHERE app_name = '@deco/management-mcp'
  `.execute(db);
}
