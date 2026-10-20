import type { Kysely } from "kysely";

/**
 * A user's GitHub token for their Copilot plan, so their sandbox-hosted
 * `claude-code` runs reach Claude through Copilot's Anthropic-compatible
 * endpoint and bill that person's Copilot seat. Same shape as
 * `claude_subscriptions` (migration 162), so one storage class serves both.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("github_copilot_subscriptions")
    .addColumn("user_id", "text", (col) => col.primaryKey())
    .addColumn("encrypted_access_token", "text", (col) => col.notNull())
    .addColumn("expires_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropTable("github_copilot_subscriptions")
    .ifExists()
    .execute();
}
