import type { Kysely } from "kysely";

/**
 * A member's linked plan shared with their whole org (GitHub Copilot today;
 * `provider_id` leaves room for others): while a row exists, every sandbox run
 * in the org prefers it.
 *
 * The row points at the sharer's own token (`github_copilot_subscriptions`)
 * instead of copying it, so re-linking carries
 * over and unlinking ends the share. Keyed per sharer so an org can later pool
 * several plans of one provider; today the oldest share is the one used.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("org_shared_plans")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("provider_id", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .addPrimaryKeyConstraint("org_shared_plans_pkey", [
      "organization_id",
      "provider_id",
      "user_id",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("org_shared_plans").ifExists().execute();
}
