/**
 * Update Deco Store Registry URL
 *
 * This migration updates the Deco Store registry connection URL from
 * the old api.decocms.com endpoint to the new studio.decocms.com endpoint.
 *
 * It also resets tools to NULL so they are fetched fresh from the new endpoint.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE connections
    SET connection_url = 'https://studio.decocms.com/org/deco/registry/mcp',
        tools = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE connection_url = 'https://api.decocms.com/mcp/registry'
      AND app_name = 'deco-registry'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE connections
    SET connection_url = 'https://api.decocms.com/mcp/registry',
        updated_at = CURRENT_TIMESTAMP
    WHERE connection_url = 'https://studio.decocms.com/org/deco/registry/mcp'
      AND app_name = 'deco-registry'
  `.execute(db);
}
