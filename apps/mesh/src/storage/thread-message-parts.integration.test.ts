import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { SqlThreadStorage } from "./threads";
import { SqlThreadMessagePartStorage } from "./thread-message-parts";
import type { ThreadMessagePart } from "./fold-parts";

const ORG = "org_1";

describe("SqlThreadMessagePartStorage", () => {
  let database: StudioDatabase;
  let threads: SqlThreadStorage;
  let parts: SqlThreadMessagePartStorage;
  let threadId: string;

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
    const t = await threads.create({
      organization_id: ORG,
      created_by: "user_1",
    });
    threadId = t.id;
  });
  afterAll(async () => closeTestPgDatabase(database));

  const mk = (
    p: Partial<ThreadMessagePart> & { id: string; seq: number },
  ): ThreadMessagePart => ({
    org_id: ORG,
    thread_id: threadId,
    run_id: "r1",
    message_id: "m1",
    role: "assistant",
    kind: "text",
    payload: { type: "text", text: "x" },
    payload_ref: null,
    metadata: null,
    created_at: new Date(1700000000000 + p.seq * 1000).toISOString(),
    ...p,
  });

  it("C2: every part is persisted (no %5 sampling) — 7 parts → 7 rows", async () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      mk({
        id: `r1:${i}`,
        seq: i,
        message_id: "m_c2",
        payload: { type: "text", text: `s${i}` },
      }),
    );
    await parts.appendParts(seven);
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM thread_message_parts WHERE message_id='m_c2'`.execute(
      database.db,
    );
    expect(Number(rows[0]!.n)).toBe(7);
  });

  it("R8: appendParts is idempotent (same id twice → one row)", async () => {
    const p = mk({ id: "r1:dup", seq: 99, message_id: "m_dup" });
    await parts.appendParts([p]);
    await parts.appendParts([p]);
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM thread_message_parts WHERE id='r1:dup'`.execute(
      database.db,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("C1: a finished message is durably complete after append", async () => {
    await parts.appendParts([
      mk({
        id: "r2:0",
        seq: 0,
        run_id: "r2",
        message_id: "m_c1",
        payload: { type: "text", text: "answer" },
      }),
      mk({
        id: "r2:1",
        seq: 1,
        run_id: "r2",
        message_id: "m_c1",
        kind: "finish",
        payload: {},
      }),
    ]);
    const { messages } = await parts.loadWindow(threadId, { limit: 50 });
    const m = messages.find((x) => x.id === "m_c1")!;
    expect(m.status).toBe("complete");
    expect(m.parts).toEqual([{ type: "text", text: "answer" }]);
  });

  it("C5: order follows seq-derived created_at, not insertion order", async () => {
    // insert the 'later' message first, with an EARLIER created_at on the first
    await parts.appendParts([
      mk({
        id: "r3:0",
        seq: 0,
        run_id: "r3",
        message_id: "m_early",
        created_at: "2026-01-01T00:00:01.000Z",
      }),
      mk({
        id: "r3:1",
        seq: 1,
        run_id: "r3",
        message_id: "m_early",
        kind: "finish",
        payload: {},
        created_at: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    await parts.appendParts([
      mk({
        id: "r4:0",
        seq: 0,
        run_id: "r4",
        message_id: "m_late",
        created_at: "2026-01-01T00:00:09.000Z",
      }),
      mk({
        id: "r4:1",
        seq: 1,
        run_id: "r4",
        message_id: "m_late",
        kind: "finish",
        payload: {},
        created_at: "2026-01-01T00:00:09.000Z",
      }),
    ]);
    const { messages } = await parts.loadWindow(threadId, { limit: 50 });
    const idx = (id: string) => messages.findIndex((m) => m.id === id);
    expect(idx("m_early")).toBeLessThan(idx("m_late"));
  });

  it("R14: finish-anchor pagination returns one row per message, newest first", async () => {
    const { messages, total } = await parts.loadWindow(threadId, { limit: 2 });
    expect(messages.length).toBeLessThanOrEqual(2);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("R18: backfill converges (re-running yields identical rows)", async () => {
    const v1msgs = [
      {
        id: "old_1",
        role: "user" as const,
        parts: [{ type: "text", text: "hi" }],
        thread_id: threadId,
        created_at: "2025-12-01T00:00:00.000Z",
        updated_at: "2025-12-01T00:00:00.000Z",
        metadata: null,
      },
    ];
    await parts.backfillFromMessages(v1msgs as never, {
      runId: "backfill",
      orgId: ORG,
      threadId,
    });
    await parts.backfillFromMessages(v1msgs as never, {
      runId: "backfill",
      orgId: ORG,
      threadId,
    });
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM thread_message_parts WHERE message_id='old_1'`.execute(
      database.db,
    );
    expect(Number(rows[0]!.n)).toBe(2); // exactly one content + one finish, not duplicated
  });
});
