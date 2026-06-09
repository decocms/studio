import { type Kysely, sql } from "kysely";

/**
 * Org-chat channels. Each row is one configured chat-platform integration
 * (Microsoft Teams, Discord, ...) that registers a synthetic bot org-member.
 * Inbound platform messages run a Decopilot agent turn and the reply is posted
 * back to the platform.
 *
 * Mirrors the AI-provider-keys shape: org-scoped, secrets vault-encrypted into a
 * single opaque blob (`encrypted_credentials`), never columnized. `metadata`
 * carries only NON-secret display info (bot display name, etc.).
 *
 * Lifecycle: a channel is created as a `draft` (no credentials yet) so the
 * inbound webhook URL — which embeds the channel id — exists before the admin
 * configures the platform portal. `CHANNEL_TEST` flips it to `active`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("channels")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    // 'teams' | 'discord' — enforced at app level, not DB level.
    .addColumn("channel_type", "text", (col) => col.notNull())
    .addColumn("label", "text", (col) => col.notNull())
    // Vault-encrypted JSON blob of the per-platform secret credentials.
    // Nullable: a draft channel has no credentials until the configure step.
    .addColumn("encrypted_credentials", "text")
    // virtual_mcp_id of the Decopilot agent the bot runs. Nullable: bound during
    // setup; runChannelTurn falls back to the org default home agent when unset.
    .addColumn("agent_id", "text")
    // Synthetic bot org-member (user.id). Managed by the app (no FK cascade so
    // the bot user/member teardown stays explicit in CHANNEL_DELETE).
    .addColumn("bot_user_id", "text", (col) => col.notNull())
    // JSON, non-secret display metadata (e.g. bot display name surfaced by TEST).
    .addColumn("metadata", "text")
    // 'draft' | 'active' | 'error' | 'disabled'
    .addColumn("status", "text", (col) => col.notNull().defaultTo("draft"))
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("idx_channels_org")
    .on("channels")
    .column("organization_id")
    .execute();

  await db.schema
    .createIndex("idx_channels_org_type")
    .on("channels")
    .columns(["organization_id", "channel_type"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("channels").execute();
}
