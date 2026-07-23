import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("brand_context")
    .addColumn("id", "text", (col) => col.primaryKey().notNull())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("domain", "text", (col) => col.notNull())
    .addColumn("overview", "text", (col) => col.notNull())
    .addColumn("logo", "text")
    .addColumn("favicon", "text")
    .addColumn("og_image", "text")
    .addColumn("fonts", "text")
    .addColumn("colors", "text")
    .addColumn("images", "text")
    .addColumn("metadata", "text")
    .addColumn("archived_at", "timestamptz")
    .addColumn("is_default", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("brand_context_organization_id_idx")
    .on("brand_context")
    .column("organization_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("brand_context").execute();
}
