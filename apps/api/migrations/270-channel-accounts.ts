import { type Kysely, sql } from "kysely";

/**
 * Channel accounts: which account of an outside channel (a Slack user, a
 * Discord user) is which Studio user, so the channels service can act as
 * that person when the account writes to a bot. A row is only ever created
 * by the person, signed in, spending a claim the service opened for them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("channel_accounts")
    .addColumn("channel", "text", (col) => col.notNull())
    .addColumn("account_id", "text", (col) => col.notNull())
    .addColumn("account_name", "text", (col) => col.notNull().defaultTo(""))
    // Where the account lives: the Slack workspace, the Discord server.
    .addColumn("account_where", "text")
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    // The organization it was connected in.
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("last_used_at", "timestamptz")
    .addPrimaryKeyConstraint("channel_accounts_pk", ["channel", "account_id"])
    .execute();

  await db.schema
    .createIndex("channel_accounts_user")
    .on("channel_accounts")
    .column("user_id")
    .execute();

  await db.schema
    .createTable("channel_account_claims")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("channel", "text", (col) => col.notNull())
    .addColumn("account_id", "text", (col) => col.notNull())
    .addColumn("account_name", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("account_where", "text")
    // The email the account must sign in as, when the channel knows one.
    .addColumn("account_email", "text")
    .addColumn("return_url", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("used_at", "timestamptz")
    .execute();

  await db.schema
    .createIndex("channel_account_claims_account")
    .on("channel_account_claims")
    .columns(["channel", "account_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("channel_account_claims").ifExists().execute();
  await db.schema.dropTable("channel_accounts").ifExists().execute();
}
