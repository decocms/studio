/**
 * Update Management MCP Connection URLs and Reset Tools
 *
 * This migration:
 * 1. Updates existing management MCP connections from `/mcp` to `/mcp/management`
 *    to match the new route structure.
 * 2. Resets the `tools` column to NULL so tools are fetched fresh from the
 *    management MCP endpoint (which has the correctly named tools).
 *
 * The management MCP endpoint has been moved from `/mcp` to `/mcp/management`
 * so that `/mcp` can serve the default virtual MCP (Decopilot).
 *
 * Setting tools to NULL causes the proxy to fall back to fetching tools
 * directly from the MCP endpoint, which returns the current ALL_TOOLS
 * with correctly renamed tools (COLLECTION_VIRTUAL_MCP_* instead of COLLECTION_GATEWAY_*).
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Update connection_url for management MCP connections
  // Match URLs that end with '/mcp' (not already '/mcp/management')
  // This handles both http://localhost:3000/mcp and https://studio.example.com/mcp
  await sql`
    UPDATE connections
    SET connection_url = connection_url || '/management',
        tools = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE connection_url LIKE '%/mcp'
      AND connection_url NOT LIKE '%/mcp/management'
      AND app_name = '@deco/management-mcp'
  `.execute(db);

  // Also reset tools for management MCP connections that already have the correct URL
  // (in case URL was manually updated but tools weren't)
  await sql`
    UPDATE connections
    SET tools = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE app_name = '@deco/management-mcp'
      AND tools IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Revert by removing '/management' from the end of the URL
  // Note: tools will remain NULL (they'll be fetched fresh on next request)
  await sql`
    UPDATE connections
    SET connection_url = SUBSTR(connection_url, 1, LENGTH(connection_url) - LENGTH('/management')),
        updated_at = CURRENT_TIMESTAMP
    WHERE connection_url LIKE '%/mcp/management'
      AND app_name = '@deco/management-mcp'
  `.execute(db);
}
