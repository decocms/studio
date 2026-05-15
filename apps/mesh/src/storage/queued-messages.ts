/**
 * Queued messages — pending agent runs awaiting dispatch on the per-thread
 * gate queue.
 *
 * Powers the chat inbox: messages the user submitted while a run was already
 * active. The workflow consumer claims a row at dispatch time (`claim`)
 * which atomically deletes it, so the table only ever holds rows that
 * haven't been picked up yet. Cancel marks `status='cancelled'` so the
 * workflow consumer skips dispatch when it dequeues.
 */

import type { Kysely } from "kysely";
import type { Database, QueuedMessage, QueuedMessageStatus } from "./types";

export interface InsertQueuedMessageInput {
  id: string;
  threadId: string;
  organizationId: string;
  userId: string;
  content: string;
  workflowId: string;
}

function mapRow(row: {
  id: string;
  thread_id: string;
  organization_id: string;
  user_id: string;
  content: string;
  status: string;
  workflow_id: string;
  created_at: Date;
}): QueuedMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    content: row.content,
    status: row.status as QueuedMessageStatus,
    workflowId: row.workflow_id,
    createdAt: row.created_at,
  };
}

export interface QueuedMessagesStorage {
  insert(input: InsertQueuedMessageInput): Promise<QueuedMessage>;
  /**
   * List rows for a thread, scoped to an org. Returns queued AND cancelled
   * rows — cancelled rows are short-lived (consumer GCs them at dequeue)
   * but the list endpoint excludes them for the inbox UI.
   */
  listByThread(
    threadId: string,
    organizationId: string,
  ): Promise<QueuedMessage[]>;
  /**
   * Atomic CAS queued→cancelled. Returns the row when the transition
   * succeeded, or null when the row was already gone (consumed) or already
   * cancelled. Used by `DELETE /messages/:id`.
   */
  cancel(id: string, organizationId: string): Promise<QueuedMessage | null>;
  /**
   * Atomic claim. Used by the workflow consumer to decide whether to
   * dispatch.
   *
   * - `"claimed"` — row existed with status='queued', deleted by this call.
   *   Dispatch should proceed.
   * - `"cancelled"` — row exists with status='cancelled'. User invoked
   *   `DELETE /messages/:id`; skip dispatch.
   * - `"missing"` — row does not exist. Treated as a DBOS replay-safety
   *   case: a prior attempt of this workflow already deleted the row, and
   *   we're re-running the claim step. Dispatch should proceed.
   *
   * Replay safety is the reason `claim` returns three states instead of a
   * boolean: a DELETE that commits but doesn't get its result recorded
   * (worker crash between the SQL ack and the DBOS step ack) must not
   * cause the replay to skip dispatch.
   */
  claim(id: string): Promise<"claimed" | "cancelled" | "missing">;
}

export class SqlQueuedMessagesStorage implements QueuedMessagesStorage {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(input: InsertQueuedMessageInput): Promise<QueuedMessage> {
    const row = await this.db
      .insertInto("queued_messages")
      .values({
        id: input.id,
        thread_id: input.threadId,
        organization_id: input.organizationId,
        user_id: input.userId,
        content: input.content,
        status: "queued",
        workflow_id: input.workflowId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapRow(row);
  }

  async listByThread(
    threadId: string,
    organizationId: string,
  ): Promise<QueuedMessage[]> {
    const rows = await this.db
      .selectFrom("queued_messages")
      .selectAll()
      .where("thread_id", "=", threadId)
      .where("organization_id", "=", organizationId)
      .where("status", "=", "queued")
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(mapRow);
  }

  async cancel(
    id: string,
    organizationId: string,
  ): Promise<QueuedMessage | null> {
    const row = await this.db
      .updateTable("queued_messages")
      .set({ status: "cancelled" })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("status", "=", "queued")
      .returningAll()
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async claim(id: string): Promise<"claimed" | "cancelled" | "missing"> {
    const deleted = await this.db
      .deleteFrom("queued_messages")
      .where("id", "=", id)
      .where("status", "=", "queued")
      .returning("id")
      .executeTakeFirst();
    if (deleted) return "claimed";

    const remaining = await this.db
      .selectFrom("queued_messages")
      .select("status")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!remaining) return "missing";
    return remaining.status === "cancelled" ? "cancelled" : "claimed";
  }
}
