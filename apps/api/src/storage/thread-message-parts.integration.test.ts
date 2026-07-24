import type { UIMessageChunk } from "ai";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { sleep } from "@decocms/shared/std";
import { SqlThreadStorage } from "./threads";
import {
  SqlThreadMessagePartStorage,
  serializePayload,
} from "./thread-message-parts";
import type { ThreadMessagePart } from "./fold-parts";
import { foldedToUIMessage } from "@/api/routes/decopilot/projector-seed";
import { createRunPersistence } from "@/api/routes/decopilot/run-persistence";
import { projectChunks } from "@/api/routes/decopilot/project-chunks";

const ORG = "org_1";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  it("R9: replaceMessageParts replaces one message snapshot and preserves its order base", async () => {
    await parts.appendParts([
      mk({
        id: "r_replace:m_replace:0",
        seq: 0,
        run_id: "r_replace",
        message_id: "m_replace",
        payload: { type: "text", text: "approval needed" },
        created_at: "2026-01-01T00:00:05.000Z",
      }),
      mk({
        id: "r_replace:m_replace:1",
        seq: 1,
        run_id: "r_replace",
        message_id: "m_replace",
        kind: "finish",
        payload: {},
        created_at: "2026-01-01T00:00:06.000Z",
      }),
    ]);

    await parts.replaceMessageParts(threadId, "m_replace", [
      mk({
        id: "r_replace:m_replace:0",
        seq: 0,
        run_id: "r_replace",
        message_id: "m_replace",
        payload: { type: "text", text: "approval needed" },
        created_at: "2099-01-01T00:00:00.000Z",
      }),
      mk({
        id: "r_replace:m_replace:1",
        seq: 1,
        run_id: "r_replace",
        message_id: "m_replace",
        kind: "tool_call",
        payload: {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
        created_at: "2099-01-01T00:00:01.000Z",
      }),
      mk({
        id: "r_replace:m_replace:2",
        seq: 2,
        run_id: "r_replace",
        message_id: "m_replace",
        kind: "finish",
        payload: {},
        created_at: "2099-01-01T00:00:02.000Z",
      }),
    ]);

    const { messages } = await parts.loadWindow(threadId, { limit: 50 });
    const message = messages.find((m) => m.id === "m_replace")!;
    expect(message.created_at).toBe("2026-01-01T00:00:05.000Z");
    expect(message.parts).toMatchObject([
      { type: "text", text: "approval needed" },
      { type: "tool-bash", state: "approval-responded" },
    ]);

    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM thread_message_parts WHERE message_id='m_replace'`.execute(
      database.db,
    );
    expect(Number(rows[0]!.n)).toBe(3);
  });

  it("R9b: replaceMessageParts survives a concurrent committed row on the same id (no dup-key throw)", async () => {
    // Regression for the prod "No response was generated": replaceMessageParts'
    // DELETE-then-INSERT is not atomic against a concurrent writer (the
    // projector's appendParts, or a redelivered consumeRunProjection step) that
    // commits a colliding (id) between the DELETE and the INSERT. A bare INSERT
    // then violated thread_message_parts_pkey, the projection step threw, and
    // the assistant message was left empty. The fix makes the INSERT
    // upsert-on-conflict.
    //
    // Reproduced deterministically: a concurrent txn inserts the colliding id
    // and holds OPEN (uncommitted) so replaceMessageParts' INSERT blocks on the
    // unique index; committing it then forces the exact conflict. (The natural
    // DELETE→INSERT window is too tight to hit by scheduling alone.)
    const M = "m_race";
    const run = "r_race";
    const mkr = (seq: number, extra: Partial<ThreadMessagePart> = {}) =>
      mk({
        id: `${run}:${M}:${seq}`,
        seq,
        run_id: run,
        message_id: M,
        ...extra,
      });

    const inserted = deferred();
    const release = deferred();
    const other = database.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("thread_message_parts")
        .values({
          id: `${run}:${M}:0`,
          seq: 0,
          org_id: ORG,
          thread_id: threadId,
          run_id: run,
          message_id: M,
          role: "assistant",
          kind: "text",
          payload: serializePayload({ type: "text", text: "concurrent" }),
          payload_ref: null,
          metadata: null,
          created_at: new Date(1700000000000).toISOString(),
        })
        .execute();
      inserted.resolve();
      await release.promise; // hold the txn open (uncommitted)
    });

    await inserted.promise;
    // DELETE sees no committed rows; the INSERT then blocks on the held id.
    const replacePromise = parts.replaceMessageParts(threadId, M, [
      mkr(0, { payload: { type: "text", text: "answer" } }),
      mkr(1, { kind: "finish", payload: {} }),
    ]);
    await sleep(300); // let replace reach and block on its INSERT
    release.resolve(); // commit the concurrent row → replace's INSERT conflicts
    await other;
    await replacePromise; // pre-fix: rejects with dup-key; post-fix: upserts

    // The message ends complete with replace's authoritative snapshot.
    const { messages } = await parts.loadWindow(threadId, { limit: 500 });
    const msg = messages.find((m) => m.id === M)!;
    expect(msg.status).toBe("complete");
    expect(msg.parts).toMatchObject([{ type: "text", text: "answer" }]);
  });

  it("deleteMessageParts hard-deletes one message's rows (incl. finish anchor) and leaves the other message intact", async () => {
    await parts.appendParts([
      mk({
        id: "r_del:m_keep:0",
        seq: 0,
        run_id: "r_del",
        message_id: "m_keep",
        payload: { type: "text", text: "keep me" },
      }),
      mk({
        id: "r_del:m_keep:1",
        seq: 1,
        run_id: "r_del",
        message_id: "m_keep",
        kind: "finish",
        payload: {},
      }),
    ]);
    await parts.appendParts([
      mk({
        id: "r_del:m_gone:0",
        seq: 0,
        run_id: "r_del",
        message_id: "m_gone",
        payload: { type: "text", text: "delete me" },
      }),
      mk({
        id: "r_del:m_gone:1",
        seq: 1,
        run_id: "r_del",
        message_id: "m_gone",
        kind: "finish",
        payload: {},
      }),
    ]);

    await parts.deleteMessageParts(threadId, "m_gone");

    const { rows: goneRows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM thread_message_parts WHERE message_id='m_gone'`.execute(
      database.db,
    );
    expect(Number(goneRows[0]!.n)).toBe(0);

    const { rows: keepRows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM thread_message_parts WHERE message_id='m_keep'`.execute(
      database.db,
    );
    expect(Number(keepRows[0]!.n)).toBe(2);

    const { messages } = await parts.loadWindow(threadId, { limit: 500 });
    expect(messages.some((m) => m.id === "m_gone")).toBe(false);
    expect(messages.some((m) => m.id === "m_keep")).toBe(true);
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
    expect(m.parts).toEqual([
      {
        type: "text",
        text: "answer",
        created_at: new Date(1700000000000).toISOString(),
      },
    ]);
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

  // ---------------------------------------------------------------------------
  // Approval continuation: no duplicate assistant message (the "Thought" bug)
  // ---------------------------------------------------------------------------
  // Scenario: a user message U0 and an assistant proposal M1 are already
  // persisted (emitRequestMessage on the continuation POST). The harness emits
  // a NEW message id M2 for the continuation run. The fix: consumeHarnessStream
  // remaps M2 onto M1 (the trailing assistant in originalMessages) so the
  // continuation merges onto the proposal row instead of creating an orphan M2.
  // Without the fix the thread would have TWO assistant messages (M1 + M2),
  // showing duplicated reasoning ("Thought") to the user.
  describe("approval continuation: no duplicate assistant message", () => {
    // Each test in this suite gets an isolated thread so it never pollutes
    // the outer threadId's rows.
    let contThreadId: string;

    beforeAll(async () => {
      const t = await threads.create({
        organization_id: ORG,
        created_by: "user_1",
      });
      contThreadId = t.id;
    });

    it("continuation merges onto proposal M1 — no orphan M2", async () => {
      // runId === threadId by convention (PartEmitter writes thread_id = runId).
      const runId = contThreadId;

      // Local helper mirroring the outer mk() but scoped to contThreadId/runId.
      const mkCont = (
        p: Partial<ThreadMessagePart> & { id: string; seq: number },
      ): ThreadMessagePart => ({
        org_id: ORG,
        thread_id: runId,
        run_id: runId,
        message_id: "m_default",
        role: "assistant",
        kind: "text",
        payload: { type: "text", text: "x" },
        payload_ref: null,
        metadata: null,
        created_at: new Date(1700000000000 + p.seq * 1000).toISOString(),
        ...p,
      });

      const USER_MSG = "cont_user_U0";
      const PROPOSAL_MSG = "cont_proposal_M1";
      const CONT_MSG_ID = "msg_continuation_M2";

      // Step 1: seed U0 (user) and M1 (assistant proposal with approval state).
      // Mirrors what emitRequestMessage writes on the continuation POST:
      // text part + tool-call in approval-responded state + finish anchor.
      // Part/payload shapes copied from R9 (replaceMessageParts test above).
      await parts.replaceMessageParts(runId, USER_MSG, [
        mkCont({
          id: `${runId}:${USER_MSG}:0`,
          seq: 0,
          message_id: USER_MSG,
          role: "user",
          kind: "text",
          payload: { type: "text", text: "run the command" },
          created_at: "2026-06-01T00:00:01.000Z",
        }),
        mkCont({
          id: `${runId}:${USER_MSG}:1`,
          seq: 1,
          message_id: USER_MSG,
          role: "user",
          kind: "finish",
          payload: {},
          created_at: "2026-06-01T00:00:02.000Z",
        }),
      ]);

      await parts.replaceMessageParts(runId, PROPOSAL_MSG, [
        mkCont({
          id: `${runId}:${PROPOSAL_MSG}:0`,
          seq: 0,
          message_id: PROPOSAL_MSG,
          role: "assistant",
          kind: "text",
          payload: { type: "text", text: "I will run a command" },
          created_at: "2026-06-01T00:00:03.000Z",
        }),
        mkCont({
          id: `${runId}:${PROPOSAL_MSG}:1`,
          seq: 1,
          message_id: PROPOSAL_MSG,
          kind: "tool_call",
          payload: {
            type: "tool-bash",
            state: "approval-responded",
            approval: { id: "ap_cont_1", approved: true },
          },
          created_at: "2026-06-01T00:00:04.000Z",
        }),
        mkCont({
          id: `${runId}:${PROPOSAL_MSG}:2`,
          seq: 2,
          message_id: PROPOSAL_MSG,
          kind: "finish",
          payload: {},
          created_at: "2026-06-01T00:00:05.000Z",
        }),
      ]);

      // Step 2: load originalMessages as the real projector does
      // (loadWindow → map foldedToUIMessage, mirroring projectFromJetStreamStep).
      const { messages: windowMessages } = await parts.loadWindow(runId, {
        limit: 500,
      });
      const originalMessages = windowMessages.map(foldedToUIMessage);

      // Sanity: the merge depends on the trailing message being the assistant
      // proposal. Assert this before projecting.
      const trailing = originalMessages.at(-1);
      expect(trailing?.role).toBe("assistant");
      expect(trailing?.id).toBe(PROPOSAL_MSG);

      // Step 3: project the continuation using the SAME persistence the real
      // projector uses (createRunPersistence + replaceFinal: true), exactly as
      // projectFromJetStreamStep does (projector-workflow.ts ~L152-157).
      const runPersistence = await createRunPersistence({
        messageParts: parts,
        orgId: ORG,
        runId,
        replaceFinal: true,
      });

      // Continuation chunk stream: start(M2) → reasoning block → text → finish.
      // Reasoning chunk shapes confirmed from ai@6.0.208 UIMessageChunk type
      // definitions: { type: "reasoning-start"|"reasoning-delta"|"reasoning-end",
      // id: string, delta?: string }.
      const continuationChunks: UIMessageChunk[] = [
        { type: "start", messageId: CONT_MSG_ID } as UIMessageChunk,
        { type: "reasoning-start", id: "r0" } as UIMessageChunk,
        {
          type: "reasoning-delta",
          id: "r0",
          delta: "Thinking about the output...",
        } as UIMessageChunk,
        { type: "reasoning-end", id: "r0" } as UIMessageChunk,
        { type: "text-start", id: "t0" } as UIMessageChunk,
        {
          type: "text-delta",
          id: "t0",
          delta: "Command output: done",
        } as UIMessageChunk,
        { type: "text-end", id: "t0" } as UIMessageChunk,
        { type: "finish", finishReason: "stop" } as UIMessageChunk,
      ];

      const result = await projectChunks({
        chunks: (async function* () {
          yield* continuationChunks;
        })(),
        persistence: runPersistence,
        originalMessages,
      });

      // 1. Projection must succeed — directly catches a total projection failure
      // that would otherwise let every assertion below pass vacuously because
      // M1 was already seeded complete.
      expect(result.failed).toBe(false);

      // Step 4: assert duplication is gone.
      const { messages: afterMessages } = await parts.loadWindow(runId, {
        limit: 500,
      });

      // No message with the raw continuation id (M2) — it was merged onto M1.
      const hasContinuationOrphan = afterMessages.some(
        (m) => m.id === CONT_MSG_ID,
      );
      expect(hasContinuationOrphan).toBe(false);

      // Exactly one assistant message for this run, id = M1.
      const assistantMessages = afterMessages.filter(
        (m) => m.role === "assistant",
      );
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]!.id).toBe(PROPOSAL_MSG);

      const m1Parts = assistantMessages[0]!.parts ?? [];

      // 2. The continuation's text content actually landed on M1 — proving the
      // merge happened (not just "no orphan"). Without this the test passes
      // vacuously when the projection fails entirely (M1 was seeded complete).
      const textParts = m1Parts.filter(
        (p) => (p as { type?: string }).type === "text",
      );
      const hasContText = textParts.some(
        (p) => (p as { text?: string }).text === "Command output: done",
      );
      expect(hasContText).toBe(true);

      // 3. The reasoning part appears exactly once (reported symptom: duplicate
      // "Thought" when M2 was persisted alongside M1 instead of merged), and
      // its text equals the continuation's reasoning delta — pinning the
      // assembled reasoning state, not just the count.
      const reasoningParts = m1Parts.filter(
        (p) => (p as { type?: string }).type === "reasoning",
      );
      expect(reasoningParts).toHaveLength(1);
      expect((reasoningParts[0] as { text?: string }).text).toBe(
        "Thinking about the output...",
      );
    });
  });
});
