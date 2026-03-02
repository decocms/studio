import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("triggers")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("title", "text")
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("trigger_type", "text", (col) => col.notNull())
    .addColumn("cron_expression", "text")
    .addColumn("event_type", "text")
    .addColumn("event_filter", "text")
    .addColumn("action_type", "text", (col) => col.notNull())
    .addColumn("connection_id", "text")
    .addColumn("tool_name", "text")
    .addColumn("tool_arguments", "text")
    .addColumn("agent_id", "text")
    .addColumn("agent_prompt", "text")
    .addColumn("event_id", "text")
    .addColumn("subscription_id", "text")
    .addColumn("last_run_at", "text")
    .addColumn("last_run_status", "text")
    .addColumn("last_run_error", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("updated_by", "text")
    .execute();

  await db.schema
    .createIndex("idx_triggers_org")
    .on("triggers")
    .columns(["organization_id"])
    .execute();

  await db.schema
    .createIndex("idx_triggers_org_enabled")
    .on("triggers")
    .columns(["organization_id", "enabled"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_triggers_org_enabled").execute();
  await db.schema.dropIndex("idx_triggers_org").execute();
  await db.schema.dropTable("triggers").execute();
}
