import { type Kysely, sql } from "kysely";

/**
 * Verified WhatsApp phone link per user (for the shared concierge number).
 *
 * Verification is inbound-only: Studio issues a unique `code`, the user sends it
 * from their WhatsApp to the concierge number, and the inbound proves ownership
 * — so `phone` is null until the code arrives and `verified_at` is stamped then.
 * One link per user; a verified phone maps to exactly one user.
 * `selected_organization_id` remembers which org answers when the user belongs
 * to several WhatsApp-enabled orgs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("user_phones")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade").unique(),
    )
    // Canonical E.164 digits (no '+'); null until the verification code arrives.
    .addColumn("phone", "text")
    .addColumn("verified_at", "timestamptz")
    // Studio-issued pending code the user must send to verify (then cleared).
    .addColumn("code", "text")
    .addColumn("code_expires_at", "timestamptz")
    .addColumn("selected_organization_id", "text", (col) =>
      col.references("organization.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Codes are matched against inbound message text — must be unique & indexed.
  await sql`
    CREATE UNIQUE INDEX idx_user_phones_code
    ON user_phones (code)
    WHERE code IS NOT NULL
  `.execute(db);

  // A verified phone resolves to exactly one user (inbound routing key).
  await sql`
    CREATE UNIQUE INDEX idx_user_phones_verified
    ON user_phones (phone)
    WHERE verified_at IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("user_phones").execute();
}
