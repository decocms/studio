import { type Kysely, sql } from "kysely";

/**
 * Rework `organization_domains` to support multiple domains per org plus DNS
 * verification (Tier 2). The table was keyed by `organization_id` (one domain
 * per org) with a single `auto_join_enabled` boolean. We:
 *   - give each row its own `id` so an org can hold many domains,
 *   - replace `auto_join_enabled` with a `join_mode` enum (off|auto|request),
 *   - add verification fields (status/method/token/verified_at).
 *
 * Existing rows were claimed by proving a matching verified email, so they're
 * backfilled as verified via the "email" method.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. New columns, nullable for the backfill pass.
  await db.schema
    .alterTable("organization_domains")
    .addColumn("id", "text")
    .addColumn("join_mode", "text")
    .addColumn("verification_status", "text")
    .addColumn("verification_method", "text")
    .addColumn("verification_token", "text")
    .addColumn("verified_at", "timestamptz")
    .execute();

  // 2. Backfill existing rows.
  await sql`
    UPDATE organization_domains
    SET
      id = gen_random_uuid()::text,
      join_mode = CASE WHEN auto_join_enabled THEN 'auto' ELSE 'off' END,
      verification_status = 'verified',
      verification_method = 'email',
      verified_at = created_at
    WHERE id IS NULL
  `.execute(db);

  // 3. Swap the primary key from organization_id to id (the FK on
  //    organization_id stays). Lock in NOT NULL + defaults on the new columns.
  await sql`ALTER TABLE organization_domains DROP CONSTRAINT organization_domains_pkey`.execute(
    db,
  );
  await sql`ALTER TABLE organization_domains ALTER COLUMN id SET NOT NULL`.execute(
    db,
  );
  await sql`ALTER TABLE organization_domains ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`.execute(
    db,
  );
  await sql`ALTER TABLE organization_domains ADD PRIMARY KEY (id)`.execute(db);
  await sql`ALTER TABLE organization_domains ALTER COLUMN join_mode SET NOT NULL`.execute(
    db,
  );
  await sql`ALTER TABLE organization_domains ALTER COLUMN join_mode SET DEFAULT 'off'`.execute(
    db,
  );
  await sql`ALTER TABLE organization_domains ALTER COLUMN verification_status SET NOT NULL`.execute(
    db,
  );
  await sql`ALTER TABLE organization_domains ALTER COLUMN verification_status SET DEFAULT 'pending'`.execute(
    db,
  );

  // 4. Drop the replaced boolean.
  await db.schema
    .alterTable("organization_domains")
    .dropColumn("auto_join_enabled")
    .execute();

  // 5. One row per (org, domain).
  await db.schema
    .createIndex("organization_domains_org_domain_idx")
    .unique()
    .ifNotExists()
    .on("organization_domains")
    .columns(["organization_id", "domain"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Best-effort reverse. Will fail if any org holds more than one domain
  // (the single-domain-per-org PK can't be restored in that case).
  await db.schema
    .dropIndex("organization_domains_org_domain_idx")
    .ifExists()
    .execute();

  await db.schema
    .alterTable("organization_domains")
    .addColumn("auto_join_enabled", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();

  await sql`
    UPDATE organization_domains
    SET auto_join_enabled = (join_mode = 'auto')
  `.execute(db);

  await sql`ALTER TABLE organization_domains DROP CONSTRAINT organization_domains_pkey`.execute(
    db,
  );
  await sql`ALTER TABLE organization_domains ADD PRIMARY KEY (organization_id)`.execute(
    db,
  );

  await db.schema
    .alterTable("organization_domains")
    .dropColumn("id")
    .dropColumn("join_mode")
    .dropColumn("verification_status")
    .dropColumn("verification_method")
    .dropColumn("verification_token")
    .dropColumn("verified_at")
    .execute();
}
