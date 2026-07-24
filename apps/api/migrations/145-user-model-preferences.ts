import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Per-user override of the org chat tier → model mapping. One row per
  // (user, org): `tiers` holds only the chat tiers the user overrode; an
  // absent tier falls back to the org default at resolve time. Cascades on
  // both user and org deletion.
  await db.schema
    .createTable("user_model_preferences")
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("tiers", "jsonb", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addPrimaryKeyConstraint("user_model_preferences_pkey", [
      "user_id",
      "organization_id",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("user_model_preferences").execute();
}
