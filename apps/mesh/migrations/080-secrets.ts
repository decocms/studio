import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("secrets")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("scope", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) =>
      col.references("user.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("encrypted_value", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_by", "text", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await sql`
    ALTER TABLE secrets
    ADD CONSTRAINT chk_secrets_scope CHECK (scope IN ('user', 'organization'))
  `.execute(db);

  await sql`
    ALTER TABLE secrets
    ADD CONSTRAINT chk_secrets_scope_user_id CHECK (
      (scope = 'user' AND user_id IS NOT NULL)
      OR (scope = 'organization' AND user_id IS NULL)
    )
  `.execute(db);

  await db.schema
    .createIndex("idx_secrets_org")
    .on("secrets")
    .column("organization_id")
    .execute();

  // Case-insensitive uniqueness within each scope bucket.
  await sql`
    CREATE UNIQUE INDEX idx_secrets_user_name
    ON secrets (organization_id, user_id, lower(name))
    WHERE scope = 'user'
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX idx_secrets_org_name
    ON secrets (organization_id, lower(name))
    WHERE scope = 'organization'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("secrets").execute();
}
