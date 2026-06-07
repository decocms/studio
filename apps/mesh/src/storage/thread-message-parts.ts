import type { Kysely } from "kysely";
import {
  foldParts,
  type FoldedMessage,
  type ThreadMessagePart,
} from "./fold-parts";
import type { Database, ThreadMessage } from "./types";

export class SqlThreadMessagePartStorage {
  constructor(private db: Kysely<Database>) {}

  /** Idempotent append; rows are immutable (ON CONFLICT (id) DO NOTHING). */
  async appendParts(parts: ThreadMessagePart[]): Promise<void> {
    if (parts.length === 0) return;
    const seen = new Set<string>();
    const rows = [];
    for (const p of parts) {
      if (seen.has(p.id)) continue; // can't affect same row twice in one INSERT
      seen.add(p.id);
      rows.push({
        id: p.id,
        seq: p.seq,
        org_id: p.org_id,
        thread_id: p.thread_id,
        run_id: p.run_id,
        message_id: p.message_id,
        role: p.role,
        kind: p.kind,
        payload: JSON.stringify(p.payload),
        payload_ref: p.payload_ref ?? null,
        metadata: p.metadata != null ? JSON.stringify(p.metadata) : null,
        created_at: p.created_at,
      });
    }
    await this.db
      .insertInto("thread_message_parts")
      .values(rows)
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }

  /**
   * Windowed read: page over the one-per-message `finish` anchors (newest
   * first), then fetch+fold the parts of exactly those messages. `total` is the
   * count of completed messages. The whole-thread fold is never executed.
   */
  async loadWindow(
    threadId: string,
    options: { limit: number; offset?: number },
  ): Promise<{ messages: FoldedMessage[]; total: number }> {
    const anchors = await this.db
      .selectFrom("thread_message_parts")
      .select(["message_id"])
      .where("thread_id", "=", threadId)
      .where("kind", "=", "finish")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(options.limit)
      .offset(options.offset ?? 0)
      .execute();

    const totalRow = await this.db
      .selectFrom("thread_message_parts")
      .select((eb) => eb.fn.count<string>("id").as("count"))
      .where("thread_id", "=", threadId)
      .where("kind", "=", "finish")
      .executeTakeFirst();
    const total = Number(totalRow?.count ?? 0);

    const messageIds = anchors.map((a) => a.message_id);
    if (messageIds.length === 0) return { messages: [], total };

    const rows = await this.db
      .selectFrom("thread_message_parts")
      .selectAll()
      .where("thread_id", "=", threadId)
      .where("message_id", "in", messageIds)
      .orderBy("seq", "asc")
      .execute();

    return {
      messages: foldParts(rows as unknown as ThreadMessagePart[]),
      total,
    };
  }

  /**
   * Upgrade-on-touch: synthesize final-only parts from a v1 thread's messages.
   * Deterministic ids (`backfill:<message_id>:content|finish`) → re-running is a
   * no-op via ON CONFLICT DO NOTHING (R18 convergence). Preserves id/role/parts/
   * created_at/order (R16); accepted loss is sub-message granularity.
   */
  async backfillFromMessages(
    messages: ThreadMessage[],
    ctx: { runId: string; orgId: string; threadId: string },
  ): Promise<void> {
    const parts: ThreadMessagePart[] = [];
    let seq = 0;
    for (const m of messages) {
      parts.push({
        id: `${ctx.runId}:${m.id}:content`,
        seq: seq++,
        org_id: ctx.orgId,
        thread_id: ctx.threadId,
        run_id: ctx.runId,
        message_id: m.id,
        role: m.role,
        kind: "text",
        payload: m.parts,
        payload_ref: null,
        metadata: m.metadata ?? null,
        created_at: m.created_at,
      });
      parts.push({
        id: `${ctx.runId}:${m.id}:finish`,
        seq: seq++,
        org_id: ctx.orgId,
        thread_id: ctx.threadId,
        run_id: ctx.runId,
        message_id: m.id,
        role: m.role,
        kind: "finish",
        payload: {},
        payload_ref: null,
        metadata: null,
        created_at: m.created_at,
      });
    }
    await this.appendParts(parts);
  }
}
