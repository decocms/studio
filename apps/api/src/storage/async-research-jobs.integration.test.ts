import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { SqlAsyncResearchJobStorage } from "./async-research-jobs";
import { SqlThreadMessagePartStorage } from "./thread-message-parts";
import { SqlThreadStorage } from "./threads";

// Integration coverage for the polling stub:
//   - markPolling seeds thread_message_parts so the v2 reader
//     (loadWindow, finish-anchored) can reconstruct an in-flight tool call.
//   - legacy v1 threads still transition to polling but do not create new
//     thread_messages or thread_message_parts stubs.
//   - terminal transitions (markCompleted/deleteStubMessage) drop the seed.
const ORG = "org_1";

async function createThread(
  db: StudioDatabase["db"],
  threads: SqlThreadStorage,
  version: number,
): Promise<string> {
  const t = await threads.create({
    organization_id: ORG,
    created_by: "user_1",
  });
  // `create` doesn't expose message_storage_version, so set it directly.
  await db
    .updateTable("threads")
    .set({ message_storage_version: version })
    .where("id", "=", t.id)
    .where("organization_id", "=", ORG)
    .execute();
  return t.id;
}

describe("SqlAsyncResearchJobStorage — polling stub (v2)", () => {
  let database: StudioDatabase;
  let threads: SqlThreadStorage;
  let parts: SqlThreadMessagePartStorage;
  let jobs: SqlAsyncResearchJobStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: "T",
        slug: "t",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const now = new Date().toISOString();
    await sql`INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES ('user_1','t@t.com',false,'T',${now},${now})`.execute(database.db);
    threads = new SqlThreadStorage(database.db);
    parts = new SqlThreadMessagePartStorage(database.db);
    jobs = new SqlAsyncResearchJobStorage(database.db);
  });
  afterAll(async () => closeTestPgDatabase(database));

  it("markPolling seeds thread_message_parts, readable via loadWindow", async () => {
    const threadId = await createThread(database.db, threads, 2);
    const toolCallId = "call_v2_1";

    await jobs.upsertPending({
      organizationId: ORG,
      threadId,
      toolCallId,
      provider: "gemini",
      modelId: "gemini-deep-research",
      query: "what is Studio?",
    });

    await jobs.markPolling(ORG, toolCallId, "interaction_v2_1", {
      threadId,
      toolName: "web_search",
      query: "what is Studio?",
    });

    const { messages } = await parts.loadWindow(threadId, { limit: 10 });
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.role).toBe("assistant");
    expect(msg.status).toBe("complete");
    const toolPart = msg.parts.find(
      (p): p is Record<string, unknown> =>
        !!p &&
        typeof p === "object" &&
        (p as Record<string, unknown>).type === "tool-web_search",
    );
    expect(toolPart).toBeDefined();
    expect(toolPart!.state).toBe("input-available");
    expect(toolPart!.toolCallId).toBe(toolCallId);
    expect(toolPart!.input).toEqual({ query: "what is Studio?" });

    // The polling stub no longer writes `thread_messages`.
    const v1 = await database.db
      .selectFrom("thread_messages")
      .select("id")
      .where("thread_id", "=", threadId)
      .execute();
    expect(v1).toHaveLength(0);
  });

  it("markCompleted drops the seed (loadWindow no longer returns it)", async () => {
    const threadId = await createThread(database.db, threads, 2);
    const toolCallId = "call_v2_2";

    await jobs.upsertPending({
      organizationId: ORG,
      threadId,
      toolCallId,
      provider: "gemini",
      modelId: "gemini-deep-research",
      query: "q",
    });
    await jobs.markPolling(ORG, toolCallId, "interaction_v2_2", {
      threadId,
      toolName: "web_search",
      query: "q",
    });
    expect(
      (await parts.loadWindow(threadId, { limit: 10 })).messages,
    ).toHaveLength(1);

    await jobs.markCompleted(ORG, toolCallId, {
      inputTokens: 1,
      outputTokens: 2,
      citations: [],
      resultUri: null,
      resultPreview: "done",
      resultContent: "done",
    });

    expect(
      (await parts.loadWindow(threadId, { limit: 10 })).messages,
    ).toHaveLength(0);
    const remaining = await database.db
      .selectFrom("thread_message_parts")
      .select("id")
      .where("thread_id", "=", threadId)
      .execute();
    expect(remaining).toHaveLength(0);
  });

  it("v1: markPolling updates the job without writing a polling stub", async () => {
    const threadId = await createThread(database.db, threads, 1);
    const toolCallId = "call_v1_1";

    await jobs.upsertPending({
      organizationId: ORG,
      threadId,
      toolCallId,
      provider: "gemini",
      modelId: "gemini-deep-research",
      query: "legacy",
    });
    await jobs.markPolling(ORG, toolCallId, "interaction_v1_1", {
      threadId,
      toolName: "web_search",
      query: "legacy",
    });

    const job = await jobs.findByToolCall(ORG, toolCallId);
    expect(job?.status).toBe("polling");
    expect(job?.interactionId).toBe("interaction_v1_1");

    const v1Rows = await database.db
      .selectFrom("thread_messages")
      .select("id")
      .where("thread_id", "=", threadId)
      .execute();
    expect(v1Rows).toHaveLength(0);

    const v2Rows = await database.db
      .selectFrom("thread_message_parts")
      .select("id")
      .where("thread_id", "=", threadId)
      .execute();
    expect(v2Rows).toHaveLength(0);
  });
});
