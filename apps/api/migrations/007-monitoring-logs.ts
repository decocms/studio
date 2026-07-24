/**
 * Monitoring Logs Table Migration
 *
 * Creates the monitoring_logs table for tracking all tool calls through the MCP proxy.
 * Includes indexes for common query patterns.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create monitoring_logs table
  // CASCADE DELETE: When organization is deleted, logs are automatically removed
  await db.schema
    .createTable("monitoring_logs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("connection_title", "text", (col) => col.notNull())
    .addColumn("tool_name", "text", (col) => col.notNull())
    .addColumn("input", "text", (col) => col.notNull()) // JSON stored as text
    .addColumn("output", "text", (col) => col.notNull()) // JSON stored as text
    .addColumn("is_error", "integer", (col) => col.notNull()) // SQLite boolean
    .addColumn("error_message", "text")
    .addColumn("duration_ms", "integer", (col) => col.notNull())
    .addColumn("timestamp", "text", (col) => col.notNull()) // ISO string
    .addColumn("user_id", "text")
    .addColumn("request_id", "text", (col) => col.notNull())
    .execute();

  // Create index for organization + timestamp queries (most common)
  await db.schema
    .createIndex("monitoring_logs_org_timestamp")
    .on("monitoring_logs")
    .columns(["organization_id", "timestamp"])
    .execute();

  // Create index for connection + timestamp queries
  await db.schema
    .createIndex("monitoring_logs_connection_timestamp")
    .on("monitoring_logs")
    .columns(["connection_id", "timestamp"])
    .execute();

  // Create index for error filtering
  await db.schema
    .createIndex("monitoring_logs_is_error")
    .on("monitoring_logs")
    .columns(["organization_id", "is_error", "timestamp"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop indexes first
  await db.schema.dropIndex("monitoring_logs_is_error").execute();
  await db.schema.dropIndex("monitoring_logs_connection_timestamp").execute();
  await db.schema.dropIndex("monitoring_logs_org_timestamp").execute();

  // Drop table
  await db.schema.dropTable("monitoring_logs").execute();
}
