/**
 * Update Management MCP Connection URLs from /mcp/management to /mcp/self
 *
 * This migration:
 * 1. Updates existing management MCP connections from `/mcp/management` to `/mcp/self`
 *    to match the new route structure.
 * 2. Resets the `tools` column to NULL so tools are fetched fresh from the
 *    management MCP endpoint.
 *
 * The management MCP endpoint has been moved from `/mcp/management` to `/mcp/self`
 * to better reflect its purpose as the self-management endpoint.
 *
 * Setting tools to NULL causes the proxy to fall back to fetching tools
 * directly from the MCP endpoint, which returns the current ALL_TOOLS.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Update connection_url for management MCP connections
  // Replace '/management' with '/self' in URLs that end with '/mcp/management'
  // This handles both http://localhost:3000/mcp/management and https://studio.example.com/mcp/management
  await sql`
    UPDATE connections
    SET connection_url = REPLACE(connection_url, '/mcp/management', '/mcp/self'),
        tools = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE connection_url LIKE '%/mcp/management'
      AND app_name = '@deco/management-mcp'
  `.execute(db);

  // Also reset tools for management MCP connections that already have the correct URL
  // (in case URL was manually updated but tools weren't)
  await sql`
    UPDATE connections
    SET tools = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE connection_url LIKE '%/mcp/self'
      AND app_name = '@deco/management-mcp'
      AND tools IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Revert by replacing '/self' with '/management' in URLs that end with '/mcp/self'
  // Note: tools will remain NULL (they'll be fetched fresh on next request)
  await sql`
    UPDATE connections
    SET connection_url = REPLACE(connection_url, '/mcp/self', '/mcp/management'),
        updated_at = CURRENT_TIMESTAMP
    WHERE connection_url LIKE '%/mcp/self'
      AND app_name = '@deco/management-mcp'
  `.execute(db);
}
