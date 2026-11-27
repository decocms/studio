import { type Kysely } from "kysely";

/**
 * The harness an automation chose for its runs (`automations/run-harness.ts`).
 * `null` (every existing row) keeps the default: the sandbox where the
 * deployment has one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("automations")
    .addColumn("harness_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("automations").dropColumn("harness_id").execute();
}
