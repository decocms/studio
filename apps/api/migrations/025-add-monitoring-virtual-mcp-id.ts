/**
 * Migration: Add virtual_mcp_id back to monitoring_logs
 *
 * The virtual_mcp_id column was removed in migration 023 because we thought
 * connection_id would be sufficient (since Virtual MCPs are now connections).
 * However, when a request goes through a Virtual MCP to an underlying connection,
 * we need to track BOTH:
 * - connection_id: The underlying connection that executed the tool
 * - virtual_mcp_id: The Virtual MCP (agent) that routed the request
 *
 * This allows proper tracking of which agent was used to make tool calls.
 */

import { type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add virtual_mcp_id column back to monitoring_logs
  await db.schema
    .alterTable("monitoring_logs")
    .addColumn("virtual_mcp_id", "text")
    .execute();

  // Create index for efficient filtering by virtual_mcp_id
  await db.schema
    .createIndex("monitoring_logs_virtual_mcp_id")
    .on("monitoring_logs")
    .columns(["virtual_mcp_id"])
    .execute();

  // Create composite index for filtering by virtual_mcp_id + timestamp
  await db.schema
    .createIndex("monitoring_logs_virtual_mcp_timestamp")
    .on("monitoring_logs")
    .columns(["virtual_mcp_id", "timestamp"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop indexes first
  await db.schema.dropIndex("monitoring_logs_virtual_mcp_timestamp").execute();
  await db.schema.dropIndex("monitoring_logs_virtual_mcp_id").execute();

  // Drop the column
  await db.schema
    .alterTable("monitoring_logs")
    .dropColumn("virtual_mcp_id")
    .execute();
}
