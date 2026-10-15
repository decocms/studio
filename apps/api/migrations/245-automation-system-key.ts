import { type Kysely, sql } from "kysely";

/**
 * Built-in automations: rows Studio seeds in every org (the board's
 * implementer first), told apart by `system_key`. One per key per org.
 *
 * The rows are seeded at boot and on org creation, not here, so a release
 * that does not know a key never sees it written.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automations ADD COLUMN system_key text`.execute(db);
  await sql`
    CREATE UNIQUE INDEX idx_automations_org_system_key
      ON automations (organization_id, system_key)
      WHERE system_key IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_automations_org_system_key`.execute(db);
  await sql`ALTER TABLE automations DROP COLUMN IF EXISTS system_key`.execute(
    db,
  );
}
