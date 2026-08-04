import type { Kysely } from "kysely";

/**
 * A user's Claude subscription token, so their sandbox-hosted `claude-code`
 * runs bill against their own Pro/Max plan instead of the org's API credit.
 *
 * The token is minted by `claude setup-token` on the user's own machine and
 * pasted into Studio — Anthropic's client does the authorizing, which is what
 * makes "who pays" the user's explicit choice rather than something Studio
 * infers on their behalf.
 *
 * Keyed by user, not by org: the credential belongs to the person, is valid
 * wherever they dispatch, and is never readable by anyone else.
 *
 * `expires_at` is nullable because the pasted token is opaque — `setup-token`
 * currently issues roughly a year, but nothing in the string says so, and
 * storing a guessed expiry would make the UI lie. Null means "no expiry we
 * know of": the token is used until Anthropic rejects it and the user pastes
 * a new one. The column exists for the day a mint path does tell us.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("claude_subscriptions")
    .addColumn("user_id", "text", (col) => col.primaryKey())
    .addColumn("encrypted_access_token", "text", (col) => col.notNull())
    .addColumn("expires_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("claude_subscriptions").ifExists().execute();
}
