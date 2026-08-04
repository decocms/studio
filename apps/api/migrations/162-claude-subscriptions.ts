import type { Kysely } from "kysely";

/**
 * A user's Claude subscription, linked via Claude Code's OAuth PKCE flow, so
 * their sandbox-hosted `claude-code` runs bill against their own Max/Pro plan
 * instead of the org's API credit.
 *
 * Keyed by user, not by org: the credential belongs to the person, is valid
 * wherever they dispatch, and is never readable by anyone else.
 *
 * Only the access token is kept. The refresh token is deliberately dropped —
 * when the token expires the user re-links, which is one button and keeps this
 * table free of a long-lived credential we would have to rotate.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("claude_subscriptions")
    .addColumn("user_id", "text", (col) => col.primaryKey())
    .addColumn("encrypted_access_token", "text", (col) => col.notNull())
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("claude_subscriptions").ifExists().execute();
}
