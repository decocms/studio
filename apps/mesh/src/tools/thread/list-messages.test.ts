import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { COLLECTION_THREAD_MESSAGES_LIST } from "./list-messages";
import { buildThreadTestContext, type ThreadTestEnv } from "./test-helpers";

describe("COLLECTION_THREAD_MESSAGES_LIST orderBy → sort translation", () => {
  let env: ThreadTestEnv;
  const threadId = "thrd_orderby_test";

  beforeAll(async () => {
    env = await buildThreadTestContext();

    await env.ctx.storage.threads.create({
      id: threadId,
      title: "orderby test",
      created_by: env.userId,
    });

    // Three messages with strictly ordered created_at so asc/desc differ.
    // Storage's listMessages also tiebreaks on id for batched inserts.
    for (const m of [
      { id: "m_1", created_at: "2026-01-01T00:00:01.000Z" },
      { id: "m_2", created_at: "2026-01-01T00:00:02.000Z" },
      { id: "m_3", created_at: "2026-01-01T00:00:03.000Z" },
    ]) {
      await env.database.db
        .insertInto("thread_messages")
        .values({
          id: m.id,
          thread_id: threadId,
          role: "user",
          parts: JSON.stringify([{ type: "text", text: m.id }]),
          metadata: null,
          created_at: m.created_at,
          updated_at: m.created_at,
        })
        .execute();
    }
  });

  afterAll(async () => {
    await env.close();
  });

  it("returns messages in ascending order by default (no orderBy)", async () => {
    const raw = await COLLECTION_THREAD_MESSAGES_LIST.handler(
      { thread_id: threadId, limit: 10, offset: 0 },
      env.ctx,
    );
    expect(raw.items.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3"]);
  });

  it("orderBy: [] (empty array) defaults to ascending", async () => {
    const raw = await COLLECTION_THREAD_MESSAGES_LIST.handler(
      { thread_id: threadId, limit: 10, offset: 0, orderBy: [] },
      env.ctx,
    );
    expect(raw.items.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3"]);
  });

  it("orderBy created_at desc returns the newest messages first", async () => {
    const raw = await COLLECTION_THREAD_MESSAGES_LIST.handler(
      {
        thread_id: threadId,
        limit: 10,
        offset: 0,
        orderBy: [{ field: ["created_at"], direction: "desc" }],
      },
      env.ctx,
    );
    expect(raw.items.map((m) => m.id)).toEqual(["m_3", "m_2", "m_1"]);
  });

  it("desc + limit 2 returns the top 2 newest (the chat-store cold-boot shape)", async () => {
    const raw = await COLLECTION_THREAD_MESSAGES_LIST.handler(
      {
        thread_id: threadId,
        limit: 2,
        offset: 0,
        orderBy: [{ field: ["created_at"], direction: "desc" }],
      },
      env.ctx,
    );
    expect(raw.items.map((m) => m.id)).toEqual(["m_3", "m_2"]);
    expect(raw.hasMore).toBe(true);
    expect(raw.totalCount).toBe(3);
  });

  it("orderBy on an unsupported field still uses the direction (storage only sorts by created_at)", async () => {
    // The translation reads orderBy[0].direction regardless of field name.
    // The storage layer hardcodes created_at as the sort column. This is the
    // current contract: callers requesting a different field get the
    // direction respected but the column silently fixed to created_at.
    const raw = await COLLECTION_THREAD_MESSAGES_LIST.handler(
      {
        thread_id: threadId,
        limit: 10,
        offset: 0,
        orderBy: [{ field: ["updated_at"], direction: "desc" }],
      },
      env.ctx,
    );
    expect(raw.items.map((m) => m.id)).toEqual(["m_3", "m_2", "m_1"]);
  });
});
