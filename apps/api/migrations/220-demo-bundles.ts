import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("demo_bundles")
    .addColumn("organization_id", "text", (c) =>
      c
        .primaryKey()
        .references("demo_organizations.organization_id")
        .onDelete("cascade"),
    )
    .addColumn("payload", "jsonb", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("demo_assets")
    .addColumn("organization_id", "text", (c) =>
      c
        .notNull()
        .references("demo_organizations.organization_id")
        .onDelete("cascade"),
    )
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("mime", "text", (c) => c.notNull())
    .addColumn("body", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("demo_assets_pk", ["organization_id", "name"])
    .execute();
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("demo_assets").execute();
  await db.schema.dropTable("demo_bundles").execute();
}
