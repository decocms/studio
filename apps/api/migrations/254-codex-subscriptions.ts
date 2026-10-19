import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("codex_subscriptions")
    .addColumn("user_id", "text", (col) =>
      col.primaryKey().references("user.id").onDelete("cascade"),
    )
    .addColumn("encrypted_auth", "text", (col) => col.notNull())
    .addColumn("auth_hash", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("codex_subscriptions").ifExists().execute();
}
