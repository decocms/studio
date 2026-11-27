import { type ColumnDefinitionBuilder, type Kysely, sql } from "kysely";

/**
 * Channels: conversations from outside sources (WhatsApp, Discord, Slack…),
 * pushed by the channel workers through the ingestion route, one connection
 * per account at the source. Its own schema keeps a source's tables apart
 * from Studio's. Every row carries its organization and cascades from it, so
 * deleting an org (or truncating it in tests) clears its channels.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createSchema("channels").ifNotExists().execute();
  const ch = db.schema.withSchema("channels");

  const organization = (col: ColumnDefinitionBuilder) =>
    col.notNull().references("public.organization.id").onDelete("cascade");

  await ch
    .createTable("connections")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", organization)
    .addColumn("source", "text", (col) => col.notNull())
    // The account at the source: the phone number, the bot id.
    .addColumn("external_id", "text", (col) => col.notNull())
    .addColumn("name", "text")
    .addColumn("kind", "text")
    // sha256 hex of the ingestion token; the plaintext is shown once.
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("created_by", "text", (col) =>
      col.references("public.user.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("last_event_at", "timestamptz")
    .addUniqueConstraint("connections_org_source_external", [
      "organization_id",
      "source",
      "external_id",
    ])
    .execute();

  const connection = (col: ColumnDefinitionBuilder) =>
    col.notNull().references("channels.connections.id").onDelete("cascade");

  await ch
    .createTable("conversations")
    .addColumn("connection_id", "text", connection)
    .addColumn("organization_id", "text", organization)
    .addColumn("external_id", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull().defaultTo("unknown"))
    .addColumn("title", "text")
    .addColumn("parent_id", "text")
    .addColumn("space", "text")
    .addColumn("started_at", "timestamptz")
    .addColumn("last_message_at", "timestamptz")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("raw", "jsonb")
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("conversations_pk", [
      "connection_id",
      "external_id",
    ])
    .execute();

  // The conversation list: newest activity first, keyset-paged.
  await sql`
    CREATE INDEX conversations_org_activity ON channels.conversations
      (organization_id, last_message_at DESC NULLS LAST, connection_id DESC, external_id DESC)
  `.execute(db);

  await ch
    .createTable("people")
    .addColumn("connection_id", "text", connection)
    .addColumn("organization_id", "text", organization)
    .addColumn("external_id", "text", (col) => col.notNull())
    .addColumn("name", "text")
    .addColumn("email", "text")
    .addColumn("phone", "text")
    .addColumn("raw", "jsonb")
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("people_pk", ["connection_id", "external_id"])
    .execute();

  await ch
    .createTable("messages")
    .addColumn("connection_id", "text", connection)
    .addColumn("organization_id", "text", organization)
    // The conversation's id at the source; WhatsApp message ids are only
    // unique within a chat, hence the three-part key.
    .addColumn("conversation_id", "text", (col) => col.notNull())
    .addColumn("external_id", "text", (col) => col.notNull())
    .addColumn("author_id", "text")
    .addColumn("author_name", "text")
    .addColumn("ts", "timestamptz", (col) => col.notNull())
    .addColumn("text", "text")
    // A transcription, an OCR: text the message didn't carry as text.
    .addColumn("derived_text", "text")
    .addColumn("kind", "text")
    .addColumn("reply_to", "text")
    .addColumn("thread_id", "text")
    .addColumn("attachments", "jsonb")
    .addColumn("offset_ms", "integer")
    .addColumn("duration_ms", "integer")
    .addColumn("edited_at", "timestamptz")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("raw", "jsonb")
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("messages_pk", [
      "connection_id",
      "conversation_id",
      "external_id",
    ])
    .execute();

  await sql`
    CREATE INDEX messages_conversation_ts ON channels.messages
      (connection_id, conversation_id, ts DESC, external_id DESC)
  `.execute(db);

  // Full-text only (no extensions); search queries must use this exact expression.
  await sql`
    CREATE INDEX messages_fts ON channels.messages USING GIN
      (to_tsvector('portuguese', coalesce(text, '') || ' ' || coalesce(derived_text, '')))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropSchema("channels").ifExists().cascade().execute();
}
