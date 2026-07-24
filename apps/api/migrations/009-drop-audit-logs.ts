/**
 * Drop legacy audit_logs table
 *
 * audit_logs was used for internal tool execution audit logging. The project now
 * relies on monitoring_logs via the MCP proxy monitoring middleware.
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Drop table (indexes are dropped automatically with the table)
  await db.schema.dropTable("audit_logs").ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Re-create legacy table for rollback compatibility (matches 001-initial-schema)
  await db.schema
    .createTable("audit_logs")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organizationId", "text") // nullable for system-level actions
    .addColumn("userId", "text", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("connectionId", "text", (col) =>
      col.references("connections.id").onDelete("set null"),
    )
    .addColumn("toolName", "text", (col) => col.notNull())
    .addColumn("allowed", "integer", (col) => col.notNull())
    .addColumn("duration", "integer")
    .addColumn("timestamp", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("requestMetadata", "text")
    .execute();

  await db.schema
    .createIndex("idx_audit_logs_organizationId")
    .on("audit_logs")
    .column("organizationId")
    .execute();

  await db.schema
    .createIndex("idx_audit_logs_userId")
    .on("audit_logs")
    .column("userId")
    .execute();

  await db.schema
    .createIndex("idx_audit_logs_timestamp")
    .on("audit_logs")
    .column("timestamp")
    .execute();
}
