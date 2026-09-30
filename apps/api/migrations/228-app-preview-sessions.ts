import { type Kysely, sql } from "kysely";

/**
 * Phone preview sessions (QR pairing) and the devices paired to them. Only
 * SHA-256 hashes of pairing codes and device tokens are stored.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("app_preview_sessions")
    .addColumn("id", "text", (col) => col.primaryKey().notNull())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("virtual_mcp_id", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("branch", "text", (col) => col.notNull())
    .addColumn("pairing_code_hash", "text", (col) => col.unique())
    .addColumn("pairing_expires_at", "timestamptz")
    .addColumn("overlay", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{"set":{},"delete":[]}'::jsonb`),
    )
    .addColumn("rev", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("idx_app_preview_sessions_owner")
    .on("app_preview_sessions")
    .columns(["organization_id", "virtual_mcp_id", "user_id"])
    .execute();

  await db.schema
    .createTable("app_preview_devices")
    .addColumn("id", "text", (col) => col.primaryKey().notNull())
    .addColumn("session_id", "text", (col) =>
      col.notNull().references("app_preview_sessions.id").onDelete("cascade"),
    )
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("last_seen_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("revoked_at", "timestamptz")
    .execute();

  await db.schema
    .createIndex("idx_app_preview_devices_session")
    .on("app_preview_devices")
    .column("session_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("app_preview_devices").execute();
  await db.schema.dropTable("app_preview_sessions").execute();
}
