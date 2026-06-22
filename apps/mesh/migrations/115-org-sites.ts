import { type Kysely, sql } from "kysely";

/**
 * `org_sites` — Studio-local tenancy source of truth for asset storage.
 *
 * Each row records that an organization owns a globally-unique site `slug`.
 * The slug is the object-key prefix namespace in the shared assets bucket
 * (`<slug>/...`), so it MUST be unique across all orgs — enforced by making
 * `slug` the primary key. Ownership here authorizes `managed` file configs to
 * mint prefix-scoped STS credentials for that slug (see
 * `file-storage/tenant-credentials.ts`), replacing the live dependency on the
 * deco admin platform. Seeded from admin during migration; see
 * `scripts/backfill-org-sites.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("org_sites")
    .addColumn("slug", "text", (col) => col.primaryKey().notNull())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("source", "text", (col) =>
      col.notNull().defaultTo("deco-import"),
    )
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_by", "text", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("idx_org_sites_org")
    .on("org_sites")
    .column("organization_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("org_sites").execute();
}
