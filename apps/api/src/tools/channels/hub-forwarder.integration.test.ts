import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { Pool } from "pg";
import type { StudioDatabase } from "@/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "@/database/test-db-pg";
import { type ChannelSourceSync, ChannelsStorage } from "@/storage/channels";
import { forwardConnection } from "./hub-forwarder";

/**
 * The forwarder against a fake channels hub: a second database on the same
 * server with the hub's `channels` tables (only the columns it reads), read
 * through a role that, like the hub's, can't see `messages.content_enc`.
 */

const SOURCE_DB = "channels_source_test";
const READER = "channels_reader_test";

describe("hub forwarder", () => {
  let database: StudioDatabase;
  let channels: ChannelsStorage;
  let admin: Pool;
  let source: Pool;
  const orgId = "org_channels_forwarder";
  let n = 0;

  /** A Studio connection and its hub id, fresh per test. */
  const connect = async () => {
    const externalId = `+5500000100${++n}`;
    const created = await channels.createConnection({
      organizationId: orgId,
      source: "whatsapp",
      externalId,
    });
    if (!created) throw new Error("connection not created");
    const hubId = `whatsapp:${externalId}`;
    await admin.query(
      `INSERT INTO channels.connections (id, source, external_id) VALUES ($1, 'whatsapp', $2)`,
      [hubId, externalId],
    );
    return { id: created.connection.id, hubId };
  };

  const syncOf = async (id: string): Promise<ChannelSourceSync> => {
    const found = (await channels.listSourceSyncs()).find((c) => c.id === id);
    if (!found) throw new Error("no sync row");
    return found;
  };

  const forward = async (id: string, limit?: number) =>
    forwardConnection(channels, source, await syncOf(id), limit);

  /** `minutesAgo` stamps mirrored_at past the forwarder's settle window. */
  const conversation = (
    hubId: string,
    ext: string,
    minutesAgo: number,
    extra: { personal_owner?: string; title?: string } = {},
  ) =>
    admin.query(
      `INSERT INTO channels.conversations
        (id, source, external_id, kind, title, primary_connection, personal_owner, mirrored_at)
        VALUES ($1, 'whatsapp', $2, 'group', $3, $4, $5, now() - make_interval(mins => $6))
        ON CONFLICT (id) DO UPDATE SET title = excluded.title, mirrored_at = excluded.mirrored_at`,
      [
        `whatsapp:${ext}`,
        ext,
        extra.title ?? null,
        hubId,
        extra.personal_owner ?? null,
        minutesAgo,
      ],
    );

  const message = (
    conv: string,
    ext: string,
    minutesAgo: number,
    extra: {
      text?: string | null;
      withheld?: boolean;
      personal?: boolean;
    } = {},
  ) =>
    admin.query(
      `INSERT INTO channels.messages
        (id, source, conversation_id, external_id, author_id, author_name, ts, text,
         content_enc, withheld, personal_owner, mirrored_at)
        VALUES ($1, 'whatsapp', $2, $3, 'whatsapp:person-1', 'Member One',
          '2026-11-01T10:00:00Z', $4, 'sealed', $5, $6, now() - make_interval(mins => $7))
        ON CONFLICT (id) DO UPDATE SET text = excluded.text, withheld = excluded.withheld,
          mirrored_at = excluded.mirrored_at`,
      [
        `whatsapp:${conv}/${ext}`,
        `whatsapp:${conv}`,
        ext,
        extra.text === undefined ? `text of ${ext}` : extra.text,
        extra.withheld ?? false,
        extra.personal ? "user-1" : null,
        minutesAgo,
      ],
    );

  const studioMessages = (connectionId: string) =>
    database.db
      .selectFrom("channels.messages")
      .select(["conversation_id", "external_id", "text", "author_id", "raw"])
      .where("connection_id", "=", connectionId)
      .orderBy("external_id")
      .execute();

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    channels = new ChannelsStorage(database.db);
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${orgId}, ${orgId}, ${orgId}, ${new Date().toISOString()})
    `.execute(database.db);

    const sourceUrl = new URL(
      process.env.DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5432/postgres",
    );
    sourceUrl.pathname = `/${SOURCE_DB}`;
    const server = await database.pool.connect();
    try {
      await server.query(`DROP DATABASE IF EXISTS ${SOURCE_DB} WITH (FORCE)`);
      await server.query(`CREATE DATABASE ${SOURCE_DB}`);
    } finally {
      server.release();
    }

    admin = new Pool({ connectionString: sourceUrl.toString() });
    await admin.query(`
      CREATE SCHEMA channels;
      CREATE TABLE channels.connections (
        id text PRIMARY KEY, source text NOT NULL, external_id text NOT NULL);
      CREATE TABLE channels.conversations (
        id text PRIMARY KEY, source text NOT NULL, external_id text NOT NULL,
        kind text, title text, parent_id text, space text,
        primary_connection text, started_at timestamptz,
        last_message_at timestamptz, deleted_at timestamptz,
        mirrored_at timestamptz NOT NULL DEFAULT now(), personal_owner text);
      CREATE TABLE channels.messages (
        id text PRIMARY KEY, source text NOT NULL, conversation_id text NOT NULL,
        external_id text NOT NULL, author_id text, author_name text,
        ts timestamptz NOT NULL, text text, derived_text text, kind text,
        reply_to text, thread_id text, attachments jsonb, offset_ms integer,
        duration_ms integer, edited_at timestamptz, deleted_at timestamptz,
        mirrored_at timestamptz NOT NULL DEFAULT now(),
        withheld boolean NOT NULL DEFAULT false, personal_owner text,
        content_enc text);
      CREATE TABLE channels.people (
        id text PRIMARY KEY, source text NOT NULL, external_id text NOT NULL,
        name text, email text, phone text,
        mirrored_at timestamptz NOT NULL DEFAULT now());
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER}') THEN
          CREATE ROLE ${READER} NOLOGIN;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA channels TO ${READER};
      GRANT SELECT ON channels.connections, channels.conversations, channels.people TO ${READER};
      GRANT SELECT (id, source, conversation_id, external_id, author_id, author_name,
        ts, text, derived_text, kind, reply_to, thread_id, attachments, offset_ms,
        duration_ms, edited_at, deleted_at, mirrored_at, withheld, personal_owner)
        ON channels.messages TO ${READER};
      INSERT INTO channels.people (id, source, external_id, name, phone)
        VALUES ('whatsapp:person-1', 'whatsapp', 'person-1', 'Member One', '+5500000000');
    `);
    source = new Pool({
      connectionString: sourceUrl.toString(),
      options: `-c role=${READER}`,
    });
  });

  afterAll(async () => {
    await source?.end();
    await admin?.end();
    await closeTestPgDatabase(database);
  });

  test("the first sync copies conversations, messages and their authors, ids at the source", async () => {
    const { id, hubId } = await connect();
    await conversation(hubId, "first-group", 10, { title: "Ops" });
    await message("first-group", "m1", 9);
    await message("first-group", "m2", 8);

    expect(await forward(id)).toEqual({ forwarded: 3 });

    expect(await studioMessages(id)).toEqual([
      {
        conversation_id: "first-group",
        external_id: "m1",
        text: "text of m1",
        author_id: "person-1",
        raw: { withheld: false },
      },
      {
        conversation_id: "first-group",
        external_id: "m2",
        text: "text of m2",
        author_id: "person-1",
        raw: { withheld: false },
      },
    ]);
    const detail = await channels.getConnection(orgId, id);
    expect(detail?.counts).toEqual({
      conversations: 1,
      messages: 2,
      people: 1,
    });
    expect(detail?.sync.last_error).toBeNull();
    expect(detail?.sync.source_cursor_at).not.toBeNull();
    const person = await database.db
      .selectFrom("channels.people")
      .select(["external_id", "name"])
      .where("connection_id", "=", id)
      .executeTakeFirst();
    expect(person).toEqual({ external_id: "person-1", name: "Member One" });
  });

  test("an incremental sync takes only what changed after the cursor, in bounded batches", async () => {
    const { id, hubId } = await connect();
    await conversation(hubId, "inc-group", 10);
    await message("inc-group", "m1", 9);
    expect(await forward(id)).toEqual({ forwarded: 2 });

    // Nothing new: nothing forwarded, the cursor stays.
    const before = (await syncOf(id)).cursor;
    expect(await forward(id)).toEqual({ forwarded: 0 });
    expect((await syncOf(id)).cursor).toEqual(before);

    // An edit re-stamps the row; two more messages arrive. Batches of 2.
    await message("inc-group", "m1", 5, { text: "edited" });
    await message("inc-group", "m2", 4);
    await message("inc-group", "m3", 3);
    expect(await forward(id, 2)).toEqual({ forwarded: 2 });
    expect(await forward(id, 2)).toEqual({ forwarded: 1 });
    expect(await forward(id, 2)).toEqual({ forwarded: 0 });
    expect(
      (await studioMessages(id)).map((m) => [m.external_id, m.text]),
    ).toEqual([
      ["m1", "edited"],
      ["m2", "text of m2"],
      ["m3", "text of m3"],
    ]);
  });

  test("rows in one hub transaction share a stamp and still page through", async () => {
    const { id, hubId } = await connect();
    await conversation(hubId, "bulk-group", 10);
    // One statement, one now(): every row gets the same mirrored_at.
    await admin.query(
      `INSERT INTO channels.messages (id, source, conversation_id, external_id, ts, mirrored_at)
        SELECT 'whatsapp:bulk-group/' || x, 'whatsapp', 'whatsapp:bulk-group', x,
          '2026-11-01T10:00:00Z', now() - interval '5 minutes'
        FROM unnest(array['a', 'b', 'c', 'd', 'e']) AS x`,
    );
    for (let i = 0; i < 3; i++) await forward(id, 2);
    expect(await forward(id, 2)).toEqual({ forwarded: 0 });
    expect((await studioMessages(id)).map((m) => m.external_id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("a withheld message arrives without content, and one that becomes withheld loses it", async () => {
    const { id, hubId } = await connect();
    await conversation(hubId, "sensitive-group", 10);
    await message("sensitive-group", "m1", 9);
    await message("sensitive-group", "m2", 9, { withheld: true });
    await forward(id);

    await message("sensitive-group", "m1", 5, { text: null, withheld: true });
    await forward(id);

    const rows = await studioMessages(id);
    expect(rows.map((m) => [m.external_id, m.text, m.raw])).toEqual([
      ["m1", null, { withheld: true }],
      ["m2", null, { withheld: true }],
    ]);
  });

  test("personal conversations and messages never leave the hub", async () => {
    const { id, hubId } = await connect();
    await conversation(hubId, "work-group", 10);
    await conversation(hubId, "private-chat", 10, { personal_owner: "user-1" });
    await message("work-group", "m1", 9);
    await message("work-group", "m2", 9, { personal: true });
    await message("private-chat", "m3", 9);

    await forward(id);

    expect((await studioMessages(id)).map((m) => m.external_id)).toEqual([
      "m1",
    ]);
    const conversations = await database.db
      .selectFrom("channels.conversations")
      .select("external_id")
      .where("connection_id", "=", id)
      .execute();
    expect(conversations).toEqual([{ external_id: "work-group" }]);
  });

  test("rows younger than the settle window wait for a later tick", async () => {
    const { id, hubId } = await connect();
    await conversation(hubId, "fresh-group", 0);
    expect(await forward(id)).toEqual({ forwarded: 0 });
  });

  test("a failed ingest records the error, keeps the cursor and doesn't throw", async () => {
    const { id, hubId } = await connect();
    await conversation(hubId, "fail-group", 10);
    await message("fail-group", "m1", 9);

    // An org that doesn't exist: the ingest's insert fails on its foreign key.
    const broken = { ...(await syncOf(id)), organizationId: "org_missing" };
    const result = await forwardConnection(channels, source, broken);
    expect(result.forwarded).toBe(0);
    expect(result.error).toBeString();
    expect((await syncOf(id)).cursor).toBeNull();
    expect((await channels.getConnection(orgId, id))?.sync.last_error).toBe(
      result.error ?? "",
    );
    expect(await studioMessages(id)).toEqual([]);

    // The next clean run picks the same rows up and clears the error.
    expect(await forward(id)).toEqual({ forwarded: 2 });
    expect(
      (await channels.getConnection(orgId, id))?.sync.last_error,
    ).toBeNull();
  });
});
