import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Drop indexes first
  await db.schema
    .dropIndex("monitoring_logs_org_timestamp")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("monitoring_logs_connection_timestamp")
    .ifExists()
    .execute();
  await db.schema.dropIndex("monitoring_logs_is_error").ifExists().execute();
  await db.schema
    .dropIndex("monitoring_logs_gateway_timestamp")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("monitoring_logs_virtual_mcp_id")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("monitoring_logs_virtual_mcp_timestamp")
    .ifExists()
    .execute();

  // Drop the table — monitoring data now stored in Parquet files
  await db.schema.dropTable("monitoring_logs").ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("monitoring_logs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("connection_id", "text", (col) => col.notNull())
    .addColumn("connection_title", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("tool_name", "text", (col) => col.notNull())
    .addColumn("input", "text", (col) => col.notNull())
    .addColumn("output", "text", (col) => col.notNull())
    .addColumn("is_error", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error_message", "text")
    .addColumn("duration_ms", "integer", (col) => col.notNull())
    .addColumn("timestamp", "text", (col) => col.notNull())
    .addColumn("user_id", "text")
    .addColumn("request_id", "text", (col) => col.notNull())
    .addColumn("user_agent", "text")
    .addColumn("virtual_mcp_id", "text")
    .addColumn("properties", "text")
    .execute();

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
}
