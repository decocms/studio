import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("git_provider_installations")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("provider_id", "text", (col) => col.notNull())
    .addColumn("installation_id", "text", (col) => col.notNull())
    .addColumn("account_login", "text", (col) => col.notNull())
    .addColumn("account_id", "text", (col) => col.notNull())
    .addColumn("account_type", "text", (col) => col.notNull())
    .addColumn("repository_selection", "text", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("idx_git_provider_installations_org")
    .on("git_provider_installations")
    .column("organization_id")
    .execute();

  await db.schema
    .createIndex("idx_git_provider_installations_org_account")
    .on("git_provider_installations")
    .columns(["organization_id", "provider_id", "account_login"])
    .execute();

  await db.schema
    .createIndex("uniq_git_provider_installation")
    .on("git_provider_installations")
    .columns(["organization_id", "provider_id", "installation_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("git_provider_installations").execute();
}
