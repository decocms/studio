import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { type ChannelEvent, ChannelsStorage } from "./channels";

describe("ChannelsStorage", () => {
  let database: StudioDatabase;
  let channels: ChannelsStorage;
  const orgId = "org_channels_a";
  const otherOrg = "org_channels_b";
  let n = 0;

  /** A fresh connection per test, so tests don't share rows. */
  const connect = async (org = orgId) => {
    const created = await channels.createConnection({
      organizationId: org,
      source: "whatsapp",
      externalId: `+5500000000${++n}`,
      name: "Support line",
    });
    if (!created) throw new Error("connection not created");
    return created;
  };

  const message = (
    conversationId: string,
    id: string,
    ts: string,
    extra: Record<string, unknown> = {},
  ): ChannelEvent =>
    ({
      type: "message.upsert",
      message: {
        id,
        conversation_id: conversationId,
        ts: new Date(ts),
        ...extra,
      },
    }) as ChannelEvent;

  const count = async (table: string, connectionId: string) => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(`channels.${table}`)}
      WHERE connection_id = ${connectionId}
    `.execute(database.db);
    return rows[0]?.n ?? 0;
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    channels = new ChannelsStorage(database.db);
    const now = new Date().toISOString();
    for (const id of [orgId, otherOrg]) {
      await sql`
        INSERT INTO "organization" (id, name, slug, "createdAt")
        VALUES (${id}, ${id}, ${id}, ${now})
      `.execute(database.db);
    }
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("a new connection returns its token once and stores only its hash", async () => {
    const { connection, token } = await connect();
    expect(token).toMatch(/^chit_[0-9a-f]{64}$/);
    expect(connection.id).toMatch(/^chan_/);
    expect(connection).not.toHaveProperty("token_hash");
    const row = await database.db
      .selectFrom("channels.connections")
      .select("token_hash")
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(await channels.connectionForToken(token)).toEqual({
      id: connection.id,
      organizationId: orgId,
    });
  });

  test("the same account can't be connected twice in an org", async () => {
    const { connection } = await connect();
    expect(
      await channels.createConnection({
        organizationId: orgId,
        source: connection.source,
        externalId: connection.external_id,
      }),
    ).toBeNull();
  });

  test("rotating a token retires the old one", async () => {
    const { connection, token } = await connect();
    const fresh = await channels.rotateToken(orgId, connection.id);
    expect(fresh).toMatch(/^chit_/);
    expect(await channels.connectionForToken(token)).toBeNull();
    expect((await channels.connectionForToken(fresh ?? ""))?.id).toBe(
      connection.id,
    );
    expect(await channels.rotateToken(otherOrg, connection.id)).toBeNull();
  });

  test("the same batch twice leaves the same rows", async () => {
    const { connection } = await connect();
    const batch: ChannelEvent[] = [
      {
        type: "conversation.upsert",
        conversation: { id: "chat-1", kind: "group", title: "Team" },
      },
      { type: "person.upsert", person: { id: "p-1", name: "Person One" } },
      message("chat-1", "m-1", "2026-01-01T10:00:00.000Z", {
        text: "first",
        attachments: [{ name: "a.png", type: "image/png", size: 10 }],
      }),
      message("chat-1", "m-2", "2026-01-01T10:01:00.000Z", { text: "draft" }),
      // The same key again in one batch: the last one wins.
      message("chat-1", "m-2", "2026-01-01T10:01:00.000Z", { text: "second" }),
    ];
    await channels.ingest(orgId, connection.id, batch);
    await channels.ingest(orgId, connection.id, batch);
    expect(await count("conversations", connection.id)).toBe(1);
    expect(await count("people", connection.id)).toBe(1);
    expect(await count("messages", connection.id)).toBe(2);

    const { messages } = await channels.listMessages(orgId, {
      connectionId: connection.id,
      conversationId: "chat-1",
      limit: 10,
    });
    expect(messages.map((m) => [m.id, m.text])).toEqual([
      ["m-2", "second"],
      ["m-1", "first"],
    ]);
    expect(messages[1]?.attachments).toEqual([
      { name: "a.png", type: "image/png", size: 10 },
    ]);

    const [listed] = await channels
      .listConnections(orgId)
      .then((all) => all.filter((c) => c.id === connection.id));
    expect(listed?.last_event_at).not.toBeNull();
  });

  test("an upsert that omits a field keeps what was stored", async () => {
    const { connection } = await connect();
    await channels.ingest(orgId, connection.id, [
      message("chat-1", "m-1", "2026-01-01T10:00:00.000Z", { text: "hello" }),
    ]);
    await channels.ingest(orgId, connection.id, [
      message("chat-1", "m-1", "2026-01-01T10:00:00.000Z", {
        derived_text: "transcribed",
      }),
    ]);
    const { messages } = await channels.listMessages(orgId, {
      connectionId: connection.id,
      conversationId: "chat-1",
      limit: 10,
    });
    expect(messages[0]).toMatchObject({
      text: "hello",
      derived_text: "transcribed",
    });
  });

  test("a message before its conversation creates a stub the conversation later fills", async () => {
    const { connection } = await connect();
    await channels.ingest(orgId, connection.id, [
      message("chat-early", "m-1", "2026-01-02T00:00:00.000Z"),
    ]);
    let { conversations } = await channels.listConversations(orgId, {
      connectionId: connection.id,
      limit: 10,
    });
    expect(conversations).toEqual([
      expect.objectContaining({
        id: "chat-early",
        kind: "unknown",
        title: null,
        last_message_at: "2026-01-02T00:00:00.000Z",
      }),
    ]);

    await channels.ingest(orgId, connection.id, [
      {
        type: "conversation.upsert",
        conversation: { id: "chat-early", kind: "direct", title: "Customer" },
      },
    ]);
    ({ conversations } = await channels.listConversations(orgId, {
      connectionId: connection.id,
      limit: 10,
    }));
    expect(conversations[0]).toMatchObject({
      kind: "direct",
      title: "Customer",
      last_message_at: "2026-01-02T00:00:00.000Z",
    });
  });

  test("last_message_at only moves forward", async () => {
    const { connection } = await connect();
    const lastAt = async () =>
      (
        await channels.listConversations(orgId, {
          connectionId: connection.id,
          limit: 1,
        })
      ).conversations[0]?.last_message_at;
    await channels.ingest(orgId, connection.id, [
      message("chat-1", "m-new", "2026-03-01T00:00:00.000Z"),
    ]);
    // An older message (a backfill) and an older conversation timestamp.
    await channels.ingest(orgId, connection.id, [
      message("chat-1", "m-old", "2026-01-01T00:00:00.000Z"),
      {
        type: "conversation.upsert",
        conversation: {
          id: "chat-1",
          last_message_at: new Date("2026-02-01T00:00:00.000Z"),
        },
      },
    ]);
    expect(await lastAt()).toBe("2026-03-01T00:00:00.000Z");
    await channels.ingest(orgId, connection.id, [
      message("chat-1", "m-newer", "2026-04-01T00:00:00.000Z"),
    ]);
    expect(await lastAt()).toBe("2026-04-01T00:00:00.000Z");
  });

  test("a delete marks the message deleted and hides it from search", async () => {
    const { connection } = await connect();
    await channels.ingest(orgId, connection.id, [
      message("chat-1", "m-1", "2026-01-01T00:00:00.000Z", {
        text: "orçamento aprovado",
      }),
    ]);
    const search = () =>
      channels.searchMessages(orgId, {
        query: "orçamento",
        connectionId: connection.id,
        limit: 10,
      });
    expect((await search()).map((m) => m.id)).toEqual(["m-1"]);

    await channels.ingest(orgId, connection.id, [
      {
        type: "message.delete",
        message: {
          id: "m-1",
          conversation_id: "chat-1",
          deleted_at: new Date("2026-01-01T01:00:00.000Z"),
        },
      },
      // A delete for a message never seen is dropped.
      {
        type: "message.delete",
        message: { id: "m-unknown", conversation_id: "chat-1" },
      },
    ]);
    const { messages } = await channels.listMessages(orgId, {
      connectionId: connection.id,
      conversationId: "chat-1",
      limit: 10,
    });
    expect(messages).toEqual([
      expect.objectContaining({
        id: "m-1",
        deleted_at: "2026-01-01T01:00:00.000Z",
      }),
    ]);
    expect(await search()).toEqual([]);
  });

  test("search matches stems in text and derived text", async () => {
    const { connection } = await connect();
    await channels.ingest(orgId, connection.id, [
      message("chat-1", "m-1", "2026-01-01T00:00:00.000Z", {
        text: "vamos aprovar os orçamentos",
      }),
      message("chat-1", "m-2", "2026-01-01T00:01:00.000Z", {
        kind: "audio",
        derived_text: "o orçamento chegou",
      }),
      message("chat-1", "m-3", "2026-01-01T00:02:00.000Z", { text: "oi" }),
    ]);
    const found = await channels.searchMessages(orgId, {
      query: "orçamento",
      connectionId: connection.id,
      limit: 10,
    });
    expect(found.map((m) => m.id)).toEqual(["m-2", "m-1"]);
  });

  test("messages page newest first through the cursor, ties broken by id", async () => {
    const { connection } = await connect();
    const ts = "2026-01-01T00:00:00.000Z";
    await channels.ingest(orgId, connection.id, [
      message("chat-1", "a", ts),
      message("chat-1", "b", ts),
      message("chat-1", "c", "2026-01-01T00:00:01.000Z"),
    ]);
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = await channels.listMessages(orgId, {
        connectionId: connection.id,
        conversationId: "chat-1",
        limit: 1,
        before,
      });
      seen.push(...page.messages.map((m) => m.id));
      before = page.nextBefore ?? undefined;
    } while (before);
    expect(seen).toEqual(["c", "b", "a"]);
  });

  test("conversations page by newest activity, never-active ones last", async () => {
    const { connection } = await connect();
    await channels.ingest(orgId, connection.id, [
      { type: "conversation.upsert", conversation: { id: "quiet" } },
      message("old", "m", "2026-01-01T00:00:00.000Z"),
      message("new", "m", "2026-02-01T00:00:00.000Z"),
      message("tie", "m", "2026-02-01T00:00:00.000Z"),
    ]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await channels.listConversations(orgId, {
        connectionId: connection.id,
        limit: 1,
        cursor,
      });
      seen.push(...page.conversations.map((c) => c.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["tie", "new", "old", "quiet"]);
  });

  test("another org sees none of it", async () => {
    const { connection } = await connect();
    await channels.ingest(orgId, connection.id, [
      message("chat-1", "m-1", "2026-01-01T00:00:00.000Z", { text: "segredo" }),
    ]);
    expect(
      (await channels.listConnections(otherOrg)).map((c) => c.id),
    ).not.toContain(connection.id);
    expect(
      (await channels.listConversations(otherOrg, { limit: 50 })).conversations,
    ).toEqual([]);
    expect(
      (
        await channels.listMessages(otherOrg, {
          connectionId: connection.id,
          conversationId: "chat-1",
          limit: 10,
        })
      ).messages,
    ).toEqual([]);
    expect(
      await channels.searchMessages(otherOrg, { query: "segredo", limit: 10 }),
    ).toEqual([]);
    expect(await channels.deleteConnection(otherOrg, connection.id)).toBe(
      false,
    );
  });

  test("deleting a connection takes everything it brought in", async () => {
    const { connection, token } = await connect();
    await channels.ingest(orgId, connection.id, [
      { type: "person.upsert", person: { id: "p-1" } },
      message("chat-1", "m-1", "2026-01-01T00:00:00.000Z"),
    ]);
    expect(await channels.deleteConnection(orgId, connection.id)).toBe(true);
    for (const table of ["conversations", "people", "messages"]) {
      expect(await count(table, connection.id)).toBe(0);
    }
    expect(await channels.connectionForToken(token)).toBeNull();
  });

  test("deleting the organization takes its channels", async () => {
    const org = "org_channels_gone";
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${org}, ${org}, ${org}, ${new Date().toISOString()})
    `.execute(database.db);
    const { connection } = await connect(org);
    await channels.ingest(org, connection.id, [
      message("chat-1", "m-1", "2026-01-01T00:00:00.000Z"),
    ]);
    await sql`DELETE FROM "organization" WHERE id = ${org}`.execute(
      database.db,
    );
    expect(await count("messages", connection.id)).toBe(0);
    expect(await count("conversations", connection.id)).toBe(0);
  });
});
