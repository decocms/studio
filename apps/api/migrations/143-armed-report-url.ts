import { type Kysely } from "kysely";

/**
 * `armed_report_url` — which site's weekly report re-run is CURRENTLY armed
 * on the reports service for this org (vs `included_report_url`, the org's
 * CHOICE). Maintained exclusively by the benefits-sync workflow: on each
 * delivery it disarms the old url / arms the new one and records what it
 * armed, so a choice change (A → B) can disarm A instead of leaking a weekly
 * billed run forever.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_billing")
    .addColumn("armed_report_url", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_billing")
    .dropColumn("armed_report_url")
    .execute();
}
