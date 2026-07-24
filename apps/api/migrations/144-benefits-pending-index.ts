import { type Kysely, sql } from "kysely";

/**
 * The benefits-sync sweep scans `benefits_reference_id IS NOT NULL AND
 * updated_at < X` every 10 minutes. Pending rows are rare (fast path clears
 * them in seconds), so a partial index keeps the sweep at a few index probes
 * regardless of how many orgs exist.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create index idx_org_billing_benefits_pending
      on organization_billing (updated_at)
      where benefits_reference_id is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists idx_org_billing_benefits_pending`.execute(db);
}
