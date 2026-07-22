import { sleep } from "@decocms/std";
import type { Kysely } from "kysely";
import {
  foldParts,
  type FoldedMessage,
  type ThreadMessagePart,
} from "./fold-parts";
import type { Database, ThreadMessage } from "./types";

// Last-resort circuit breaker only — legitimate tool output (a large file
// read, a big stdout capture) is stored in full. A single part this size
// is almost certainly a runaway/erroneous payload, not real content worth
// keeping.
const MAX_PART_PAYLOAD_BYTES = 50_000_000;

// Bounds the size-estimate traversal itself: a deeply-nested-but-small
// object shouldn't be able to turn the probe into its own stall.
const MAX_ESTIMATE_NODES = 100_000;

// A synchronous loop over many/large parts' JSON.stringify calls can block
// the event loop long enough to starve health probes and stall the whole
// worker — this has happened in production. Yield back to the event loop
// every few parts instead of doing the whole batch in one synchronous pass.
const SERIALIZE_YIELD_EVERY = 25;

/**
 * Upper-bound the payload's serialized size WITHOUT calling JSON.stringify.
 * A string's `.length` is O(1) (no copy) — it's the escaping/copying that
 * JSON.stringify does which is expensive, not knowing the size. Bails out
 * (returns Infinity) the moment the running total clears `budget`, so an
 * oversized payload never pays for its own full serialization just to be
 * measured and discarded.
 */
function estimatePayloadBytes(value: unknown, budget: number): number {
  let total = 0;
  let nodes = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    if (total > budget || ++nodes > MAX_ESTIMATE_NODES) return Infinity;
    const v = stack.pop();
    if (typeof v === "string") {
      total += v.length; // UTF-16 units — a fine over-estimate of UTF-8 bytes
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (v !== null && typeof v === "object") {
      for (const item of Object.values(v)) stack.push(item);
    }
  }
  return total;
}

// Postgres `jsonb`/`text` cannot store U+0000, and rejects unpaired UTF-16
// surrogates, with SQLSTATE 22P05 ("unsupported Unicode escape sequence").
// A part whose payload carries either — e.g. a tool result that inlined raw
// binary such as a PNG (full of NUL bytes) — fails the INSERT and, because the
// projection step is the sole writer of terminal thread status, strands the
// whole run `in_progress` forever. Content arriving from the harness/desktop is
// untrusted, so sanitize it here at the storage boundary rather than trusting
// every producer. Clean strings are returned unchanged, so ids derived from the
// serialized payload stay stable.
const NUL = /\u0000/g;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function sanitizeForPg(value: string): string {
  return value.replace(NUL, "").replace(LONE_SURROGATE, "\uFFFD");
}

export function serializePayload(payload: unknown): string {
  if (
    estimatePayloadBytes(payload, MAX_PART_PAYLOAD_BYTES) >
    MAX_PART_PAYLOAD_BYTES
  ) {
    return JSON.stringify({
      truncated: true,
      reason: "payload exceeds max stored size",
    });
  }
  // A JSON replacer visits every string in the payload tree; clean strings pass
  // through untouched (byte-identical output, so ids derived from the payload
  // stay stable).
  return JSON.stringify(payload, (_key, value) =>
    typeof value === "string" ? sanitizeForPg(value) : value,
  );
}

export class SqlThreadMessagePartStorage {
  constructor(private db: Kysely<Database>) {}

  private async serializeParts(parts: ThreadMessagePart[]): Promise<{
    rows: Array<{
      id: string;
      seq: number;
      org_id: string;
      thread_id: string;
      run_id: string;
      message_id: string;
      role: ThreadMessagePart["role"];
      kind: ThreadMessagePart["kind"];
      payload: string;
      payload_ref: string | null;
      metadata: string | null;
      created_at: string;
    }>;
    partsById: Map<string, ThreadMessagePart>;
  }> {
    const seen = new Set<string>();
    const rows: Array<{
      id: string;
      seq: number;
      org_id: string;
      thread_id: string;
      run_id: string;
      message_id: string;
      role: ThreadMessagePart["role"];
      kind: ThreadMessagePart["kind"];
      payload: string;
      payload_ref: string | null;
      metadata: string | null;
      created_at: string;
    }> = [];
    const partsById = new Map<string, ThreadMessagePart>();
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (seen.has(p.id)) continue; // can't affect same row twice in one INSERT
      seen.add(p.id);
      partsById.set(p.id, p);
      rows.push({
        id: p.id,
        seq: p.seq,
        org_id: p.org_id,
        thread_id: p.thread_id,
        run_id: p.run_id,
        message_id: p.message_id,
        role: p.role,
        kind: p.kind,
        payload: serializePayload(p.payload),
        payload_ref: p.payload_ref ?? null,
        metadata: p.metadata != null ? serializePayload(p.metadata) : null,
        created_at: p.created_at,
      });
      if ((i + 1) % SERIALIZE_YIELD_EVERY === 0) await sleep(0);
    }
    return { rows, partsById };
  }

  /** Idempotent append; rows are immutable (ON CONFLICT (id) DO NOTHING). */
  async appendParts(parts: ThreadMessagePart[]): Promise<ThreadMessagePart[]> {
    if (parts.length === 0) return [];
    const { rows, partsById } = await this.serializeParts(parts);
    const inserted = await this.db
      .insertInto("thread_message_parts")
      .values(rows)
      .onConflict((oc) => oc.column("id").doNothing())
      .returning("id")
      .execute();
    return inserted
      .map((row) => partsById.get(row.id))
      .filter((part): part is ThreadMessagePart => part !== undefined);
  }

  /**
   * Replace one folded message snapshot. Used only by the `/messages` request
   * boundary, where an assistant approval/tool continuation re-posts the same
   * message id with newer request-state parts. Projection writes remain
   * append-only via `appendParts`.
   */
  async replaceMessageParts(
    threadId: string,
    messageId: string,
    parts: ThreadMessagePart[],
  ): Promise<ThreadMessagePart[]> {
    const { rows } = await this.serializeParts(parts);
    await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("thread_message_parts")
        .select((eb) => eb.fn.min("created_at").as("created_at"))
        .where("thread_id", "=", threadId)
        .where("message_id", "=", messageId)
        .executeTakeFirst();
      const existingBase =
        existing?.created_at != null
          ? new Date(existing.created_at as unknown as string).getTime()
          : null;
      const rowsToInsert =
        existingBase != null && Number.isFinite(existingBase)
          ? rows.map((row) => ({
              ...row,
              created_at: new Date(existingBase + row.seq).toISOString(),
            }))
          : rows;
      await trx
        .deleteFrom("thread_message_parts")
        .where("thread_id", "=", threadId)
        .where("message_id", "=", messageId)
        .execute();
      if (rowsToInsert.length > 0) {
        await trx
          .insertInto("thread_message_parts")
          .values(rowsToInsert)
          // Concurrency / DBOS-retry safety: this DELETE-then-INSERT is not
          // atomic against a concurrent writer (the projector's `appendParts`,
          // or a redelivered `consumeRunProjection` step) that commits a
          // colliding `id` between our DELETE and INSERT. A bare INSERT then
          // fails the whole batch on `thread_message_parts_pkey`, the
          // projection step throws, and the assistant message is left empty
          // ("No response was generated"). This method owns the authoritative
          // snapshot, so overwrite the row on conflict rather than aborting.
          .onConflict((oc) =>
            oc.column("id").doUpdateSet((eb) => ({
              seq: eb.ref("excluded.seq"),
              role: eb.ref("excluded.role"),
              kind: eb.ref("excluded.kind"),
              payload: eb.ref("excluded.payload"),
              payload_ref: eb.ref("excluded.payload_ref"),
              metadata: eb.ref("excluded.metadata"),
              created_at: eb.ref("excluded.created_at"),
            })),
          )
          .execute();
      }
    });
    return parts;
  }

  /**
   * Hard-delete every part row (including the finish anchor) of one message.
   * Used when a QUEUED user turn is removed from the thread's gate queue —
   * the request message was persisted at POST time, so cancelling the gate
   * workflow alone would leave an orphaned bubble that reappears on reload.
   * Caller must have verified thread ownership (tenant scope).
   */
  async deleteMessageParts(threadId: string, messageId: string): Promise<void> {
    await this.db
      .deleteFrom("thread_message_parts")
      .where("thread_id", "=", threadId)
      .where("message_id", "=", messageId)
      .execute();
  }

  /**
   * Highest `created_at` (epoch ms) already persisted for a run, or null when
   * the run has no parts yet. The projector uses this as its PartEmitter base
   * so a freshly-projected message sorts AFTER everything already in the thread
   * (its own user message + prior turns) even when the durable projection runs
   * far behind wall-clock — `created_at` is `base + seq`, and ordering across
   * messages keys on the first part's `created_at`.
   */
  async maxCreatedAtMsForRun(runId: string): Promise<number | null> {
    const row = await this.db
      .selectFrom("thread_message_parts")
      .select((eb) => eb.fn.max("created_at").as("max"))
      .where("run_id", "=", runId)
      .executeTakeFirst();
    if (!row?.max) return null;
    const ms = new Date(row.max as unknown as string).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * Highest `created_at` (epoch ms) persisted for ONE message of a run, or null
   * when that message has no parts yet. The projector uses the request message's
   * own max as the assistant base so a reply sorts immediately after ITS user
   * message — excluding later-queued turns that share `run_id` (== threadId) but
   * were POSTed after this turn. See run-persistence.ts.
   */
  async maxCreatedAtMsForMessage(
    runId: string,
    messageId: string,
  ): Promise<number | null> {
    const row = await this.db
      .selectFrom("thread_message_parts")
      .select((eb) => eb.fn.max("created_at").as("max"))
      .where("run_id", "=", runId)
      .where("message_id", "=", messageId)
      .executeTakeFirst();
    if (!row?.max) return null;
    const ms = new Date(row.max as unknown as string).getTime();
    return Number.isFinite(ms) ? ms : null;
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
