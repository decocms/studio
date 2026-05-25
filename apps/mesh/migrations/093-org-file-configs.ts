import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("org_file_configs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("bucket", "text", (col) => col.notNull())
    .addColumn("region", "text", (col) => col.notNull())
    .addColumn("endpoint", "text")
    .addColumn("force_path_style", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .addColumn("prefix", "text")
    .addColumn("encrypted_credentials", "text", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_by", "text", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("idx_org_file_configs_org")
    .on("org_file_configs")
    .column("organization_id")
    .execute();

  // Case-insensitive uniqueness within an org.
  await sql`
    CREATE UNIQUE INDEX idx_org_file_configs_org_name
    ON org_file_configs (organization_id, lower(name))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("org_file_configs").execute();
}
