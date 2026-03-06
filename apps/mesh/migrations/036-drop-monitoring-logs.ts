/**
 * Drop the monitoring_logs table.
 *
 * Data has been migrated to NDJSON files queried via ClickHouse (chdb/remote).
 * See Plans 01-04 for the new monitoring pipeline.
 *
 * Historical data is intentionally not migrated — monitoring data is ephemeral
 * (tool call logs) with a 30-day retention policy.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("monitoring_logs").ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Recreate the monitoring_logs table for rollback.
  // Schema matches the cumulative result of migrations 007, 013, 015, 022, 024, 025.
  await db.schema
    .createTable("monitoring_logs")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("connection_title", "text", (col) => col.notNull())
    .addColumn("tool_name", "text", (col) => col.notNull())
    .addColumn("input", "text", (col) => col.notNull())
    .addColumn("output", "text", (col) => col.notNull())
    .addColumn("is_error", "integer", (col) => col.notNull())
    .addColumn("error_message", "text")
    .addColumn("duration_ms", "integer", (col) => col.notNull())
    .addColumn("timestamp", "text", (col) => col.notNull())
    .addColumn("user_id", "text")
    .addColumn("request_id", "text", (col) => col.notNull())
    .addColumn("user_agent", "text")
    .addColumn("virtual_mcp_id", "text")
    .addColumn("properties", "text")
    .execute();

  // Recreate indexes
  await db.schema
    .createIndex("monitoring_logs_org_timestamp")
    .on("monitoring_logs")
    .columns(["organization_id", "timestamp"])
    .execute();

  await db.schema
    .createIndex("monitoring_logs_connection_timestamp")
    .on("monitoring_logs")
    .columns(["connection_id", "timestamp"])
    .execute();

  await db.schema
    .createIndex("monitoring_logs_is_error")
    .on("monitoring_logs")
    .columns(["organization_id", "is_error", "timestamp"])
    .execute();

  await db.schema
    .createIndex("monitoring_logs_virtual_mcp_id")
    .on("monitoring_logs")
    .columns(["virtual_mcp_id"])
    .execute();

  await db.schema
    .createIndex("monitoring_logs_virtual_mcp_timestamp")
    .on("monitoring_logs")
    .columns(["virtual_mcp_id", "timestamp"])
    .execute();
}
