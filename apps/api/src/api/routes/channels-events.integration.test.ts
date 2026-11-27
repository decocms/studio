process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { auth } from "../../auth";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import { ChannelsStorage } from "../../storage/channels";
import { createApp } from "../app";

describe("the channel ingestion route", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let channels: ChannelsStorage;

  const post = (
    org: string,
    connectionId: string,
    body: unknown,
    bearer: string,
  ) =>
    app.fetch(
      new Request(
        `http://test/api/${org}/channels/connections/${connectionId}/events`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: typeof body === "string" ? body : JSON.stringify(body),
        },
      ),
    );

  const connect = async (org: string, externalId: string) => {
    const created = await channels.createConnection({
      organizationId: org,
      source: "discord",
      externalId,
    });
    if (!created) throw new Error("connection not created");
    return { id: created.connection.id, token: created.token };
  };

  const events = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: "message.upsert",
      message: {
        id: `m-${i}`,
        conversation_id: "chat-1",
        ts: "2026-01-01T00:00:00.000Z",
        text: `message ${i}`,
      },
    }));

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    channels = new ChannelsStorage(database.db);
    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "verifyApiKey").mockResolvedValue({
      valid: false,
      error: { message: "invalid api key" },
      key: null,
    } as never);
    app = await createApp({ database, disableNats: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.shutdown();
    if (database) await closeTestPgDatabase(database);
  });

  it("refuses a missing, malformed or unknown token, another connection's, and another org's alike", async () => {
    const mine = await connect("org_1", "bot-1");
    const sibling = await connect("org_1", "bot-2");
    const foreign = await connect("org_456", "bot-1");
    const attempts: [string, string, string][] = [
      ["org_1", mine.id, ""],
      ["org_1", mine.id, "not-a-token"],
      ["org_1", mine.id, `chit_${"0".repeat(64)}`],
      ["org_1", mine.id, sibling.token],
      ["org_1", mine.id, foreign.token],
      // The right pair, under another org's path.
      ["org_456", mine.id, mine.token],
      ["org_456", foreign.id, mine.token],
    ];
    for (const [org, id, token] of attempts) {
      const res = await post(org, id, { events: events(1) }, token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    }
  });

  it("refuses an empty, oversized or malformed batch", async () => {
    const { id, token } = await connect("org_1", "bot-1");
    for (const body of [
      "not json",
      {},
      { events: [] },
      { events: events(501) },
      { events: [{ type: "message.upsert", message: { id: "m" } }] },
      { events: [{ type: "nope" }] },
      {
        events: [
          {
            type: "message.upsert",
            message: { id: "m", conversation_id: "c", ts: "yesterday" },
          },
        ],
      },
    ]) {
      const res = await post("org_1", id, body, token);
      expect(res.status).toBe(400);
    }
  });

  it("accepts a batch, by org slug or org id, and applies it once", async () => {
    await database.db
      .insertInto("organization")
      .values({
        id: "org_ingest",
        slug: "ingest-team",
        name: "Ingest",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const { id, token } = await connect("org_ingest", "bot-1");
    const batch = {
      events: [
        {
          type: "conversation.upsert",
          conversation: { id: "chat-1", kind: "channel", title: "general" },
        },
        { type: "person.upsert", person: { id: "u-1", name: "Someone" } },
        ...events(500 - 2),
      ],
    };
    for (const org of ["ingest-team", "org_ingest"]) {
      const res = await post(org, id, batch, token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: 500 });
    }
    const page = await channels.listMessages("org_ingest", {
      connectionId: id,
      conversationId: "chat-1",
      limit: 500,
    });
    expect(page.messages).toHaveLength(498);
    const { conversations } = await channels.listConversations("org_ingest", {
      connectionId: id,
      limit: 10,
    });
    expect(conversations).toEqual([
      expect.objectContaining({ id: "chat-1", title: "general" }),
    ]);
  });
});
