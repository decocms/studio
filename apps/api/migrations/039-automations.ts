/**
 * Automations Migration
 *
 * Creates the `automations` and `automation_triggers` tables for scheduled
 * and event-driven automation workflows.
 *
 * Also adds `trigger_id` to the `threads` table so that threads created by
 * automation runs can be traced back to their trigger.
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create automations table
  await db.schema
    .createTable("automations")
    .addColumn("id", "text", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("active", "boolean", (col) => col.notNull().defaultTo(true))
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("agent", "text", (col) => col.notNull()) // JSONB: { id, mode }
    .addColumn("messages", "text", (col) => col.notNull()) // JSONB: UIMessage[]
    .addColumn("models", "text", (col) => col.notNull()) // JSONB: { connectionId, thinking, coding?, fast? }
    .addColumn("temperature", "real", (col) => col.notNull().defaultTo(0.5))
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Indexes for automations
  await db.schema
    .createIndex("idx_automations_org")
    .on("automations")
    .columns(["organization_id"])
    .execute();

  await db.schema
    .createIndex("idx_automations_active")
    .on("automations")
    .columns(["organization_id", "active"])
    .execute();

  // Create automation_triggers table
  await db.schema
    .createTable("automation_triggers")
    .addColumn("id", "text", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("automation_id", "text", (col) =>
      col.notNull().references("automations.id").onDelete("cascade"),
    )
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("cron_expression", "text")
    .addColumn("connection_id", "text")
    .addColumn("event_type", "text")
    .addColumn("params", "text") // JSON
    .addColumn("next_run_at", "text")
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Add check constraints for trigger types
  await sql`ALTER TABLE automation_triggers ADD CONSTRAINT chk_trigger_type CHECK (type IN ('cron', 'event'))`.execute(
    db,
  );
  await sql`ALTER TABLE automation_triggers ADD CONSTRAINT chk_cron_trigger CHECK (type != 'cron' OR cron_expression IS NOT NULL)`.execute(
    db,
  );
  await sql`ALTER TABLE automation_triggers ADD CONSTRAINT chk_event_trigger CHECK (type != 'event' OR (connection_id IS NOT NULL AND event_type IS NOT NULL))`.execute(
    db,
  );

  // Indexes for automation_triggers
  await db.schema
    .createIndex("idx_automation_triggers_automation")
    .on("automation_triggers")
    .columns(["automation_id"])
    .execute();

  await db.schema
    .createIndex("idx_automation_triggers_event")
    .on("automation_triggers")
    .columns(["connection_id", "event_type"])
    .execute();

  await db.schema
    .createIndex("idx_automation_triggers_cron")
    .on("automation_triggers")
    .columns(["next_run_at"])
    .execute();

  // Add trigger_id to threads
  await db.schema
    .alterTable("threads")
    .addColumn("trigger_id", "text", (col) =>
      col.references("automation_triggers.id").onDelete("set null"),
    )
    .execute();

  await db.schema
    .createIndex("idx_threads_trigger_status")
    .on("threads")
    .columns(["trigger_id", "status"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop in reverse order
  await db.schema.dropIndex("idx_threads_trigger_status").execute();
  await db.schema.alterTable("threads").dropColumn("trigger_id").execute();

  await db.schema.dropIndex("idx_automation_triggers_cron").execute();
  await db.schema.dropIndex("idx_automation_triggers_event").execute();
  await db.schema.dropIndex("idx_automation_triggers_automation").execute();
  await db.schema.dropTable("automation_triggers").execute();

  await db.schema.dropIndex("idx_automations_active").execute();
  await db.schema.dropIndex("idx_automations_org").execute();
  await db.schema.dropTable("automations").execute();
}
