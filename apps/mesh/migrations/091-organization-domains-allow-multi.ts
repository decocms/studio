import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Drop the UNIQUE constraint on `domain` so multiple organizations can
  // claim the same domain (e.g. several orgs onboarding from the same
  // corporate domain, each opting into auto-join independently). The PK
  // remains `organization_id`, so each org still owns at most one domain.
  await sql`
    ALTER TABLE organization_domains
    DROP CONSTRAINT IF EXISTS organization_domains_domain_key
  `.execute(db);

  // Add a non-unique index for the by-domain lookup path used by the
  // auto-join endpoints (was previously served by the unique index).
  await db.schema
    .createIndex("organization_domains_domain_idx")
    .ifNotExists()
    .on("organization_domains")
    .column("domain")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropIndex("organization_domains_domain_idx")
    .ifExists()
    .execute();
  await sql`
    ALTER TABLE organization_domains
    ADD CONSTRAINT organization_domains_domain_key UNIQUE (domain)
  `.execute(db);
}
