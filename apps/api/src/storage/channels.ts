import { createHash, randomBytes } from "node:crypto";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import type { Database } from "./types";

/**
 * Channels (migration 276): connections to outside sources and what their
 * workers push through the ingestion route. Every read and write is scoped
 * by organization; ingestion is scoped by the connection its token belongs to.
 */

// ---------------------------------------------------------------------------
// The ingestion contract. Every id is the id at the source.
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(512);
const text = z.string().max(100_000);
const label = z.string().max(1000);
const stamp = z.iso
  .datetime({ offset: true })
  // Milliseconds, as JS keeps them, so a paging cursor round-trips exactly.
  .transform((value) => new Date(value));
const raw = z.record(z.string(), z.unknown());

export const ChannelEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("conversation.upsert"),
    conversation: z.object({
      id,
      kind: label.optional(),
      title: label.optional(),
      parent_id: id.optional(),
      space: label.optional(),
      started_at: stamp.optional(),
      last_message_at: stamp.optional(),
      deleted_at: stamp.optional(),
      raw: raw.optional(),
    }),
  }),
  z.object({
    type: z.literal("person.upsert"),
    person: z.object({
      id,
      name: label.optional(),
      email: label.optional(),
      phone: label.optional(),
      raw: raw.optional(),
    }),
  }),
  z.object({
    type: z.literal("message.upsert"),
    message: z.object({
      id,
      conversation_id: id,
      author_id: id.optional(),
      author_name: label.optional(),
      ts: stamp,
      text: text.optional(),
      derived_text: text.optional(),
      kind: label.optional(),
      reply_to: id.optional(),
      thread_id: id.optional(),
      attachments: z
        .array(
          z.object({
            name: label.optional(),
            type: label.optional(),
            size: z.number().int().nonnegative().optional(),
            url: z.string().max(4000).optional(),
          }),
        )
        .max(100)
        .optional(),
      offset_ms: z.number().int().optional(),
      duration_ms: z.number().int().nonnegative().optional(),
      edited_at: stamp.optional(),
      raw: raw.optional(),
    }),
  }),
  z.object({
    type: z.literal("message.delete"),
    message: z.object({
      id,
      conversation_id: id,
      deleted_at: stamp.optional(),
    }),
  }),
]);

export type ChannelEvent = z.infer<typeof ChannelEventSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ChannelConnection {
  id: string;
  source: string;
  external_id: string;
  name: string | null;
  kind: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_event_at: string | null;
}

export interface ChannelConversation {
  connection_id: string;
  id: string;
  kind: string;
  title: string | null;
  parent_id: string | null;
  space: string | null;
  started_at: string | null;
  last_message_at: string | null;
}

export interface ChannelMessage {
  connection_id: string;
  conversation_id: string;
  id: string;
  author_id: string | null;
  author_name: string | null;
  ts: string;
  text: string | null;
  derived_text: string | null;
  kind: string | null;
  reply_to: string | null;
  thread_id: string | null;
  attachments: unknown;
  offset_ms: number | null;
  duration_ms: number | null;
  edited_at: string | null;
  deleted_at: string | null;
}

export const CHANNEL_TOKEN_PREFIX = "chit_";

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function newToken(): { token: string; hash: string } {
  const token = `${CHANNEL_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  return { token, hash: hashToken(token) };
}

/** Keyset cursors are opaque to callers. */
const encodeCursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(
      JSON.parse(Buffer.from(cursor, "base64url").toString()),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const ConversationCursor = z.object({
  at: z.string().nullable(),
  c: z.string(),
  e: z.string(),
});
const MessageCursor = z.object({ ts: z.string(), e: z.string() });

/** The text a search matches; must stay identical to the `messages_fts` index. */
const searchable = sql`to_tsvector('portuguese', coalesce(text, '') || ' ' || coalesce(derived_text, ''))`;

const json = (value: unknown) =>
  value === undefined ? null : JSON.stringify(value);

/** Last occurrence wins: one INSERT … ON CONFLICT can't touch a key twice. */
function lastByKey<T>(items: T[], key: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    map.delete(k);
    map.set(k, item);
  }
  return [...map.values()];
}

/** In an upsert: the incoming value, or the stored one when none came. */
const keep = (table: string, column: string) =>
  sql<never>`coalesce(excluded.${sql.ref(column)}, ${sql.ref(`${table}.${column}`)})`;

export class ChannelsStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** A new connection and its token; the plaintext is never stored. */
  async createConnection(input: {
    organizationId: string;
    source: string;
    externalId: string;
    name?: string;
    kind?: string;
    createdBy?: string | null;
  }): Promise<{ connection: ChannelConnection; token: string } | null> {
    const { token, hash } = newToken();
    const row = await this.db
      .insertInto("channels.connections")
      .values({
        id: generatePrefixedId("chan"),
        organization_id: input.organizationId,
        source: input.source,
        external_id: input.externalId,
        name: input.name ?? null,
        kind: input.kind ?? null,
        token_hash: hash,
        created_by: input.createdBy ?? null,
      })
      .onConflict((oc) =>
        oc.columns(["organization_id", "source", "external_id"]).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    return row ? { connection: connectionOf(row), token } : null;
  }

  /** A new token for a connection; the old one stops working at once. */
  async rotateToken(
    organizationId: string,
    connectionId: string,
  ): Promise<string | null> {
    const { token, hash } = newToken();
    const res = await this.db
      .updateTable("channels.connections")
      .set({ token_hash: hash, updated_at: new Date() })
      .where("organization_id", "=", organizationId)
      .where("id", "=", connectionId)
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0 ? token : null;
  }

  async listConnections(organizationId: string): Promise<ChannelConnection[]> {
    const rows = await this.db
      .selectFrom("channels.connections")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(connectionOf);
  }

  /** Deletes the connection and, by cascade, everything it brought in. */
  async deleteConnection(
    organizationId: string,
    connectionId: string,
  ): Promise<boolean> {
    const res = await this.db
      .deleteFrom("channels.connections")
      .where("organization_id", "=", organizationId)
      .where("id", "=", connectionId)
      .executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }

  /** The connection a token was issued for, or null. */
  async connectionForToken(
    token: string,
  ): Promise<{ id: string; organizationId: string } | null> {
    const row = await this.db
      .selectFrom("channels.connections")
      .select(["id", "organization_id"])
      .where("token_hash", "=", hashToken(token))
      .executeTakeFirst();
    return row ? { id: row.id, organizationId: row.organization_id } : null;
  }

  /**
   * Apply a batch of events in one transaction, one statement per kind of
   * row. Upserts are idempotent: an omitted (or null) field keeps what was
   * stored. A message whose conversation hasn't arrived gets a stub.
   */
  async ingest(
    organizationId: string,
    connectionId: string,
    events: ChannelEvent[],
  ): Promise<void> {
    const base = {
      connection_id: connectionId,
      organization_id: organizationId,
    };
    const conversations = lastByKey(
      events.flatMap((e) =>
        e.type === "conversation.upsert" ? [e.conversation] : [],
      ),
      (c) => c.id,
    );
    const people = lastByKey(
      events.flatMap((e) => (e.type === "person.upsert" ? [e.person] : [])),
      (p) => p.id,
    );
    const messages = lastByKey(
      events.flatMap((e) => (e.type === "message.upsert" ? [e.message] : [])),
      (m) => `${m.conversation_id}\u0000${m.id}`,
    );
    const deletes = lastByKey(
      events.flatMap((e) => (e.type === "message.delete" ? [e.message] : [])),
      (m) => `${m.conversation_id}\u0000${m.id}`,
    );
    const latest = new Map<string, Date>();
    for (const m of messages) {
      const prev = latest.get(m.conversation_id);
      if (!prev || m.ts > prev) latest.set(m.conversation_id, m.ts);
    }
    const now = new Date();

    await this.db.transaction().execute(async (trx) => {
      if (conversations.length) {
        await trx
          .insertInto("channels.conversations")
          .values(
            conversations.map((c) => ({
              ...base,
              external_id: c.id,
              kind: c.kind ?? "unknown",
              title: c.title ?? null,
              parent_id: c.parent_id ?? null,
              space: c.space ?? null,
              started_at: c.started_at ?? null,
              last_message_at: c.last_message_at ?? null,
              deleted_at: c.deleted_at ?? null,
              raw: json(c.raw),
              updated_at: now,
            })),
          )
          .onConflict((oc) =>
            oc.columns(["connection_id", "external_id"]).doUpdateSet({
              kind: sql<string>`case when excluded.kind = 'unknown' then conversations.kind else excluded.kind end`,
              title: keep("conversations", "title"),
              parent_id: keep("conversations", "parent_id"),
              space: keep("conversations", "space"),
              started_at: keep("conversations", "started_at"),
              last_message_at: sql<Date>`greatest(conversations.last_message_at, excluded.last_message_at)`,
              deleted_at: keep("conversations", "deleted_at"),
              raw: keep("conversations", "raw"),
              updated_at: now,
            }),
          )
          .execute();
      }

      if (people.length) {
        await trx
          .insertInto("channels.people")
          .values(
            people.map((p) => ({
              ...base,
              external_id: p.id,
              name: p.name ?? null,
              email: p.email ?? null,
              phone: p.phone ?? null,
              raw: json(p.raw),
              updated_at: now,
            })),
          )
          .onConflict((oc) =>
            oc.columns(["connection_id", "external_id"]).doUpdateSet({
              name: keep("people", "name"),
              email: keep("people", "email"),
              phone: keep("people", "phone"),
              raw: keep("people", "raw"),
              updated_at: now,
            }),
          )
          .execute();
      }

      if (messages.length) {
        await trx
          .insertInto("channels.messages")
          .values(
            messages.map((m) => ({
              ...base,
              conversation_id: m.conversation_id,
              external_id: m.id,
              author_id: m.author_id ?? null,
              author_name: m.author_name ?? null,
              ts: m.ts,
              text: m.text ?? null,
              derived_text: m.derived_text ?? null,
              kind: m.kind ?? null,
              reply_to: m.reply_to ?? null,
              thread_id: m.thread_id ?? null,
              attachments: json(m.attachments),
              offset_ms: m.offset_ms ?? null,
              duration_ms: m.duration_ms ?? null,
              edited_at: m.edited_at ?? null,
              raw: json(m.raw),
              updated_at: now,
            })),
          )
          .onConflict((oc) =>
            oc
              .columns(["connection_id", "conversation_id", "external_id"])
              .doUpdateSet({
                author_id: keep("messages", "author_id"),
                author_name: keep("messages", "author_name"),
                ts: sql<Date>`excluded.ts`,
                text: keep("messages", "text"),
                derived_text: keep("messages", "derived_text"),
                kind: keep("messages", "kind"),
                reply_to: keep("messages", "reply_to"),
                thread_id: keep("messages", "thread_id"),
                attachments: keep("messages", "attachments"),
                offset_ms: keep("messages", "offset_ms"),
                duration_ms: keep("messages", "duration_ms"),
                edited_at: keep("messages", "edited_at"),
                raw: keep("messages", "raw"),
                updated_at: now,
              }),
          )
          .execute();

        // A stub for a conversation not seen yet, and activity that only
        // ever moves forward.
        await trx
          .insertInto("channels.conversations")
          .values(
            [...latest].map(([conversationId, ts]) => ({
              ...base,
              external_id: conversationId,
              last_message_at: ts,
              updated_at: now,
            })),
          )
          .onConflict((oc) =>
            oc.columns(["connection_id", "external_id"]).doUpdateSet({
              last_message_at: sql<Date>`greatest(conversations.last_message_at, excluded.last_message_at)`,
            }),
          )
          .execute();
      }

      if (deletes.length) {
        // Only messages already stored: a delete for one never seen is dropped.
        await sql`
          UPDATE channels.messages AS m
          SET deleted_at = d.deleted_at, updated_at = ${now}
          FROM (VALUES ${sql.join(
            deletes.map(
              (d) =>
                sql`(${d.conversation_id}, ${d.id}, ${d.deleted_at ?? now}::timestamptz)`,
            ),
          )}) AS d(conversation_id, external_id, deleted_at)
          WHERE m.connection_id = ${connectionId}
            AND m.conversation_id = d.conversation_id
            AND m.external_id = d.external_id
        `.execute(trx);
      }

      await trx
        .updateTable("channels.connections")
        .set({ last_event_at: now })
        .where("id", "=", connectionId)
        .where("organization_id", "=", organizationId)
        .execute();
    });
  }

  /** Conversations by newest activity; never-active ones last. */
  async listConversations(
    organizationId: string,
    opts: {
      connectionId?: string;
      query?: string;
      limit: number;
      cursor?: string;
    },
  ): Promise<{
    conversations: ChannelConversation[];
    nextCursor: string | null;
  }> {
    const after = opts.cursor
      ? decodeCursor(opts.cursor, ConversationCursor)
      : null;
    let q = this.db
      .selectFrom("channels.conversations")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("deleted_at", "is", null);
    if (opts.connectionId) q = q.where("connection_id", "=", opts.connectionId);
    if (opts.query) {
      q = q.where("title", "ilike", `%${escapeLike(opts.query)}%`);
    }
    if (after) {
      const tail = sql<boolean>`(connection_id, external_id) < (${after.c}, ${after.e})`;
      q = q.where(
        after.at === null
          ? sql<boolean>`last_message_at is null and ${tail}`
          : sql<boolean>`(last_message_at < ${after.at}::timestamptz
              or last_message_at is null
              or (last_message_at = ${after.at}::timestamptz and ${tail}))`,
      );
    }
    const rows = await q
      .orderBy(sql`last_message_at desc nulls last`)
      .orderBy("connection_id", "desc")
      .orderBy("external_id", "desc")
      .limit(opts.limit + 1)
      .execute();
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      conversations: page.map((r) => ({
        connection_id: r.connection_id,
        id: r.external_id,
        kind: r.kind,
        title: r.title,
        parent_id: r.parent_id,
        space: r.space,
        started_at: isoOrNull(r.started_at),
        last_message_at: isoOrNull(r.last_message_at),
      })),
      nextCursor:
        rows.length > opts.limit && last
          ? encodeCursor({
              at: isoOrNull(last.last_message_at),
              c: last.connection_id,
              e: last.external_id,
            })
          : null,
    };
  }

  /** A conversation's messages, newest first; deleted ones included, marked. */
  async listMessages(
    organizationId: string,
    opts: {
      connectionId: string;
      conversationId: string;
      limit: number;
      before?: string;
    },
  ): Promise<{ messages: ChannelMessage[]; nextBefore: string | null }> {
    const before = opts.before
      ? decodeCursor(opts.before, MessageCursor)
      : null;
    let q = this.db
      .selectFrom("channels.messages")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("connection_id", "=", opts.connectionId)
      .where("conversation_id", "=", opts.conversationId);
    if (before) {
      q = q.where(
        sql<boolean>`(ts, external_id) < (${before.ts}::timestamptz, ${before.e})`,
      );
    }
    const rows = await q
      .orderBy("ts", "desc")
      .orderBy("external_id", "desc")
      .limit(opts.limit + 1)
      .execute();
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      messages: page.map(messageOf),
      nextBefore:
        rows.length > opts.limit && last
          ? encodeCursor({ ts: iso(last.ts), e: last.external_id })
          : null,
    };
  }

  /** Full-text search over text and derived text, newest first. */
  async searchMessages(
    organizationId: string,
    opts: { query: string; connectionId?: string; limit: number },
  ): Promise<ChannelMessage[]> {
    let q = this.db
      .selectFrom("channels.messages")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("deleted_at", "is", null)
      .where(
        sql<boolean>`${searchable} @@ websearch_to_tsquery('portuguese', ${opts.query})`,
      );
    if (opts.connectionId) q = q.where("connection_id", "=", opts.connectionId);
    const rows = await q
      .orderBy("ts", "desc")
      .orderBy("external_id", "desc")
      .limit(opts.limit)
      .execute();
    return rows.map(messageOf);
  }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const iso = (d: Date | string) => new Date(d).toISOString();
const isoOrNull = (d: Date | string | null) => (d ? iso(d) : null);

function connectionOf(row: {
  id: string;
  source: string;
  external_id: string;
  name: string | null;
  kind: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  last_event_at: Date | null;
}): ChannelConnection {
  return {
    id: row.id,
    source: row.source,
    external_id: row.external_id,
    name: row.name,
    kind: row.kind,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    last_event_at: isoOrNull(row.last_event_at),
  };
}

function messageOf(row: {
  connection_id: string;
  conversation_id: string;
  external_id: string;
  author_id: string | null;
  author_name: string | null;
  ts: Date;
  text: string | null;
  derived_text: string | null;
  kind: string | null;
  reply_to: string | null;
  thread_id: string | null;
  attachments: unknown;
  offset_ms: number | null;
  duration_ms: number | null;
  edited_at: Date | null;
  deleted_at: Date | null;
}): ChannelMessage {
  return {
    connection_id: row.connection_id,
    conversation_id: row.conversation_id,
    id: row.external_id,
    author_id: row.author_id,
    author_name: row.author_name,
    ts: iso(row.ts),
    text: row.text,
    derived_text: row.derived_text,
    kind: row.kind,
    reply_to: row.reply_to,
    thread_id: row.thread_id,
    attachments: row.attachments,
    offset_ms: row.offset_ms,
    duration_ms: row.duration_ms,
    edited_at: isoOrNull(row.edited_at),
    deleted_at: isoOrNull(row.deleted_at),
  };
}
