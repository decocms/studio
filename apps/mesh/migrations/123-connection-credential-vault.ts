import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("connection_workload_tokens")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("subject_connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("token_prefix", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull().defaultTo("default"))
    .addColumn("revoked_at", "timestamptz")
    .addColumn("last_used_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("idx_connection_workload_tokens_subject")
    .on("connection_workload_tokens")
    .columns(["organization_id", "subject_connection_id"])
    .execute();

  await sql`
    CREATE UNIQUE INDEX idx_connection_workload_tokens_active_unique
    ON connection_workload_tokens (organization_id, subject_connection_id, name)
    WHERE revoked_at IS NULL
  `.execute(db);

  await db.schema
    .createTable("connection_credential_grants")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("subject_connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("target_connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("scope", "text", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("idx_connection_credential_grants_subject")
    .on("connection_credential_grants")
    .columns(["organization_id", "subject_connection_id"])
    .execute();

  await db.schema
    .createIndex("idx_connection_credential_grants_target")
    .on("connection_credential_grants")
    .columns(["organization_id", "target_connection_id"])
    .execute();

  await db.schema
    .createIndex("idx_connection_credential_grants_unique")
    .on("connection_credential_grants")
    .columns([
      "organization_id",
      "subject_connection_id",
      "target_connection_id",
      "scope",
    ])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropTable("connection_credential_grants")
    .ifExists()
    .execute();
  await db.schema.dropTable("connection_workload_tokens").ifExists().execute();
}
