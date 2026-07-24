import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("organization_domains")
    .addColumn("organization_id", "text", (col) =>
      col
        .primaryKey()
        .notNull()
        .references("organization.id")
        .onDelete("cascade"),
    )
    .addColumn("domain", "text", (col) => col.notNull().unique())
    .addColumn("auto_join_enabled", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("organization_domains").execute();
}
