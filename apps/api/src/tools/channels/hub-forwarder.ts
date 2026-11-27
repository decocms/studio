/**
 * Copies the channels hub into Studio. The hub's Postgres keeps every channel
 * in one `channels` schema, stamped with `mirrored_at` whenever a row
 * changes; each Studio connection keeps a cursor there and, per tick, takes
 * the next rows of its hub connection (`<source>:<external_id>`) and feeds
 * them to the same ingest the workers' route uses.
 *
 * Personal rows never leave the hub. Sensitive (withheld) messages arrive
 * without content and clear whatever content Studio had for them.
 */

import type { Pool } from "pg";
import type {
  ChannelEvent,
  ChannelSourceSync,
  ChannelsStorage,
} from "@/storage/channels";

/** Rows per connection per tick, conversations and messages together. */
const HUB_BATCH = 1000;

export interface HubCursor {
  at: string;
  id: string;
}

interface HubRow {
  id: string;
  external_id: string;
  /** ISO, microseconds: the cursor must be exact. */
  mirrored_at: string;
}

export interface HubConversation extends HubRow {
  kind: string | null;
  title: string | null;
  parent_id: string | null;
  space: string | null;
  started_at: Date | null;
  last_message_at: Date | null;
  deleted_at: Date | null;
}

export interface HubMessage extends HubRow {
  conversation_external_id: string;
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
  withheld: boolean;
}

export interface HubPerson {
  external_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

const after = (a: HubRow, b: HubCursor) =>
  a.mirrored_at > b.at || (a.mirrored_at === b.at && a.id > b.id);

/**
 * The first `limit` rows of both streams in (mirrored_at, id) order, and the
 * cursor after them. Each stream comes sorted and capped at `limit`, so this
 * prefix is exactly what one query over both would have returned.
 */
export function takeInOrder(
  conversations: HubConversation[],
  messages: HubMessage[],
  limit: number,
): {
  conversations: HubConversation[];
  messages: HubMessage[];
  cursor: HubCursor | null;
} {
  let c = 0;
  let m = 0;
  let last: HubRow | null = null;
  while (c + m < limit && (c < conversations.length || m < messages.length)) {
    const conv = conversations[c];
    const msg = messages[m];
    if (conv && (!msg || !after(conv, { at: msg.mirrored_at, id: msg.id }))) {
      last = conv;
      c++;
    } else if (msg) {
      last = msg;
      m++;
    }
  }
  return {
    conversations: conversations.slice(0, c),
    messages: messages.slice(0, m),
    cursor: last ? { at: last.mirrored_at, id: last.id } : null,
  };
}

const opt = <T>(value: T | null): T | undefined => value ?? undefined;

/** Hub ids are `<source>:<id>`; Studio keeps the id at the source. */
const strip = (source: string, id: string | null) =>
  id?.startsWith(`${source}:`) ? id.slice(source.length + 1) : opt(id);

/** Each source shapes its attachments; keep what the ingest contract names. */
function attachmentsOf(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return value.flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const r = a as Record<string, unknown>;
    const size = r.bytes ?? r.size;
    return [
      {
        name: str(r.file_name) ?? str(r.filename) ?? str(r.name),
        type: str(r.mimetype) ?? str(r.content_type) ?? str(r.type),
        size:
          typeof size === "number" && Number.isInteger(size) && size >= 0
            ? size
            : undefined,
        url: str(r.url),
      },
    ];
  });
}

/** Hub rows as ingestion events for a connection of `source`. */
export function toEvents(
  source: string,
  rows: {
    conversations: HubConversation[];
    messages: HubMessage[];
    people: HubPerson[];
  },
): ChannelEvent[] {
  const events: ChannelEvent[] = [];
  for (const c of rows.conversations) {
    events.push({
      type: "conversation.upsert",
      conversation: {
        id: c.external_id,
        kind: opt(c.kind),
        title: opt(c.title),
        parent_id: strip(source, c.parent_id),
        space: opt(c.space),
        started_at: opt(c.started_at),
        last_message_at: opt(c.last_message_at),
        deleted_at: opt(c.deleted_at),
      },
    });
  }
  for (const p of rows.people) {
    events.push({
      type: "person.upsert",
      person: {
        id: p.external_id,
        name: opt(p.name),
        email: opt(p.email),
        phone: opt(p.phone),
      },
    });
  }
  for (const m of rows.messages) {
    events.push({
      type: "message.upsert",
      message: {
        id: m.external_id,
        conversation_id: m.conversation_external_id,
        author_id: strip(source, m.author_id),
        author_name: opt(m.author_name),
        ts: m.ts,
        text: m.withheld ? undefined : opt(m.text),
        derived_text: m.withheld ? undefined : opt(m.derived_text),
        kind: opt(m.kind),
        reply_to: opt(m.reply_to),
        thread_id: opt(m.thread_id),
        attachments: m.withheld ? undefined : attachmentsOf(m.attachments),
        offset_ms: opt(m.offset_ms),
        duration_ms: opt(m.duration_ms),
        edited_at: opt(m.edited_at),
        // Always sent, so a message that stops being withheld shows again.
        raw: { withheld: m.withheld },
      },
    });
    if (m.deleted_at) {
      events.push({
        type: "message.delete",
        message: {
          id: m.external_id,
          conversation_id: m.conversation_external_id,
          deleted_at: m.deleted_at,
        },
      });
    }
  }
  return events;
}

const mirroredAt = (t: string) =>
  `to_char(${t}.mirrored_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * After the cursor ($2, $3), in an order Postgres and JS agree on ("C"). The
 * plain `mirrored_at >= $2` is what the (mirrored_at, id) index can range
 * over; the row comparison alone (with COLLATE "C") can't use it.
 *
 * ponytail: a hub transaction stamps mirrored_at at its start, so a row can
 * commit behind a cursor that already passed it. Rows younger than a minute
 * wait a tick; a hub transaction open longer than that can still be missed.
 */
const next = (t: string) =>
  `${t}.mirrored_at < now() - interval '1 minute'
    AND ($2::timestamptz IS NULL
      OR (${t}.mirrored_at >= $2::timestamptz
        AND (${t}.mirrored_at, ${t}.id COLLATE "C") > ($2::timestamptz, $3::text)))`;

/**
 * The next rows of one hub connection after `cursor`. Explicit columns only:
 * the hub login may not read every column (content_enc).
 */
async function readHub(
  source: Pool,
  hubConnectionId: string,
  cursor: HubCursor | null,
  limit: number,
) {
  const params = [hubConnectionId, cursor?.at ?? null, cursor?.id ?? "", limit];
  const [conversations, messages] = await Promise.all([
    source.query<HubConversation>(
      `SELECT id, external_id, kind, title, parent_id, space, started_at,
          last_message_at, deleted_at, ${mirroredAt("c")} AS mirrored_at
        FROM channels.conversations c
        WHERE primary_connection = $1 AND personal_owner IS NULL AND ${next("c")}
        ORDER BY c.mirrored_at, c.id COLLATE "C"
        LIMIT $4`,
      params,
    ),
    source.query<HubMessage>(
      `SELECT m.id, m.external_id, c.external_id AS conversation_external_id,
          m.author_id, m.author_name, m.ts,
          CASE WHEN m.withheld THEN NULL ELSE m.text END AS text,
          CASE WHEN m.withheld THEN NULL ELSE m.derived_text END AS derived_text,
          CASE WHEN m.withheld THEN NULL ELSE m.attachments END AS attachments,
          m.kind, m.reply_to, m.thread_id, m.offset_ms, m.duration_ms,
          m.edited_at, m.deleted_at, m.withheld,
          ${mirroredAt("m")} AS mirrored_at
        FROM channels.messages m
        JOIN channels.conversations c ON c.id = m.conversation_id
        WHERE c.primary_connection = $1 AND c.personal_owner IS NULL
          AND m.personal_owner IS NULL AND ${next("m")}
        ORDER BY m.mirrored_at, m.id COLLATE "C"
        LIMIT $4`,
      params,
    ),
  ]);
  const batch = takeInOrder(conversations.rows, messages.rows, limit);
  const authors = [
    ...new Set(
      batch.messages.flatMap((m) => (m.author_id ? [m.author_id] : [])),
    ),
  ];
  const people = authors.length
    ? (
        await source.query<HubPerson>(
          `SELECT external_id, name, email, phone FROM channels.people
            WHERE id = ANY($1::text[])`,
          [authors],
        )
      ).rows
    : [];
  return { ...batch, people };
}

/**
 * One connection's tick. Never throws: a failure is recorded on the
 * connection (the cursor stays) and the next connection still runs.
 */
export async function forwardConnection(
  storage: ChannelsStorage,
  source: Pool,
  connection: ChannelSourceSync,
  limit = HUB_BATCH,
): Promise<{ forwarded: number; error?: string }> {
  try {
    const batch = await readHub(
      source,
      `${connection.source}:${connection.externalId}`,
      connection.cursor,
      limit,
    );
    if (batch.cursor) {
      await storage.ingest(
        connection.organizationId,
        connection.id,
        toEvents(connection.source, batch),
      );
    }
    await storage.recordSourceSync(connection.id, batch.cursor);
    return { forwarded: batch.conversations.length + batch.messages.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await storage.recordSourceError(connection.id, error).catch(() => {});
    return { forwarded: 0, error };
  }
}
