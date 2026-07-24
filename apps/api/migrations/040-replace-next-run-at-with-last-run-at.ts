/**
 * Replace next_run_at with last_run_at on automation_triggers
 *
 * Instead of storing when a trigger should run next (fragile — a failed update
 * can lose the trigger), we store when it last ran. The cron worker computes
 * due-ness from the cron expression + last_run_at, making scheduling resilient
 * to crashes and missed updates.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_automation_triggers_cron").execute();

  await db.schema
    .alterTable("automation_triggers")
    .dropColumn("next_run_at")
    .execute();

  await db.schema
    .alterTable("automation_triggers")
    .addColumn("last_run_at", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("automation_triggers")
    .dropColumn("last_run_at")
    .execute();

  await db.schema
    .alterTable("automation_triggers")
    .addColumn("next_run_at", "text")
    .execute();

  await db.schema
    .createIndex("idx_automation_triggers_cron")
    .on("automation_triggers")
    .columns(["next_run_at"])
    .execute();
}
