import { type Kysely, sql } from "kysely";

/**
 * Shareable invite links: anyone holding the URL can join the org with
 * `role` until `expires_at`, unless an admin revokes it first. Only the
 * sha256 of the token is stored, so a database read never yields a usable
 * link. Links go away with their organization.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("organization_invite_links")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("role", "text", (col) => col.notNull().defaultTo("user"))
    .addColumn("redirect_path", "text")
    .addColumn("created_by", "text", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("use_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("organization_invite_links_org_expires_idx")
    .ifNotExists()
    .on("organization_invite_links")
    .columns(["organization_id", "expires_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("organization_invite_links").ifExists().execute();
}
