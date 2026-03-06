/**
 * Thread Storage Implementation
 *
 * Handles CRUD operations for chat threads and messages using Kysely (database-agnostic).
 * Threads are organization-scoped, messages are thread-scoped.
 */

import type { Kysely } from "kysely";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import { DEFAULT_THREAD_TITLE } from "@/api/routes/decopilot/constants";
import type { ThreadStoragePort } from "./ports";
import type {
  Database,
  Thread,
  ThreadMember,
  ThreadMessage,
  ThreadStatus,
} from "./types";

function toIsoString(v: Date | string): string {
  return typeof v === "string" ? v : v.toISOString();
}

// ============================================================================
// Thread Storage Implementation
// ============================================================================

export class SqlThreadStorage implements ThreadStoragePort {
  constructor(private db: Kysely<Database>) {}

  // ==========================================================================
  // Thread Operations
  // ==========================================================================

  async create(data: Partial<Thread>): Promise<Thread> {
    const id = data.id ?? generatePrefixedId("thrd");
    const now = new Date().toISOString();

    if (!data.organization_id) {
      throw new Error("organization_id is required");
    }
    if (!data.created_by) {
      throw new Error("created_by is required");
    }
    if (!data.title) {
      data.title = DEFAULT_THREAD_TITLE;
    }

    const row = {
      id,
      organization_id: data.organization_id,
      title: data.title,
      description: data.description ?? null,
      status: data.status ?? "completed",
      created_at: now,
      updated_at: now,
      created_by: data.created_by,
      updated_by: data.updated_by ?? null,
    };

    const result = await this.db
      .insertInto("threads")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.threadFromDbRow(result);
  }

  async get(id: string): Promise<Thread | null> {
    const row = await this.db
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? this.threadFromDbRow(row) : null;
  }

  async update(id: string, data: Partial<Thread>): Promise<Thread> {
    const now = new Date().toISOString();

    const updateData: Record<string, unknown> = {
      updated_at: now,
    };

    if (data.title !== undefined) {
      updateData.title = data.title;
    }
    if (data.description !== undefined) {
      updateData.description = data.description;
    }
    if (data.updated_by !== undefined) {
      updateData.updated_by = data.updated_by;
    }
    if (data.hidden !== undefined) {
      updateData.hidden = data.hidden;
    }
    if (data.status !== undefined) {
      updateData.status = data.status;
    }

    await this.db
      .updateTable("threads")
      .set(updateData)
      .where("id", "=", id)
      .execute();

    const thread = await this.get(id);
    if (!thread) {
      throw new Error("Thread not found after update");
    }

    return thread;
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("threads").where("id", "=", id).execute();
  }

  async list(
    organizationId: string,
    userId?: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ threads: Thread[]; total: number }> {
    // When a userId is given we want: threads owned by userId OR shared with userId.
    // The LEFT JOIN is constrained to the current user so each thread appears at most once.
    let query = this.db
      .selectFrom("threads")
      .leftJoin("thread_members", (join) =>
        join
          .onRef("thread_members.thread_id", "=", "threads.id")
          .on("thread_members.user_id", "=", userId ?? ""),
      )
      .select([
        "threads.id",
        "threads.organization_id",
        "threads.title",
        "threads.description",
        "threads.hidden",
        "threads.status",
        "threads.created_at",
        "threads.updated_at",
        "threads.created_by",
        "threads.updated_by",
        "thread_members.user_id as member_user_id",
      ])
      .where("threads.organization_id", "=", organizationId)
      .where("threads.hidden", "=", false)
      .orderBy("threads.updated_at", "desc");

    if (userId) {
      query = query.where((eb) =>
        eb.or([
          eb("threads.created_by", "=", userId),
          eb("thread_members.user_id", "=", userId),
        ]),
      );
    }

    let countQuery = this.db
      .selectFrom("threads")
      .leftJoin("thread_members", (join) =>
        join
          .onRef("thread_members.thread_id", "=", "threads.id")
          .on("thread_members.user_id", "=", userId ?? ""),
      )
      .select((eb) => eb.fn.count("threads.id").as("count"))
      .where("threads.organization_id", "=", organizationId)
      .where("threads.hidden", "=", false);

    if (userId) {
      countQuery = countQuery.where((eb) =>
        eb.or([
          eb("threads.created_by", "=", userId),
          eb("thread_members.user_id", "=", userId),
        ]),
      );
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.offset) {
      query = query.offset(options.offset);
    }

    const [rows, countResult] = await Promise.all([
      query.execute(),
      countQuery.executeTakeFirst(),
    ]);

    return {
      threads: rows.map((row) =>
        this.threadFromDbRow({
          ...row,
          is_shared: userId
            ? row.created_by !== userId && row.member_user_id === userId
            : false,
        }),
      ),
      total: Number(countResult?.count || 0),
    };
  }

  /**
   * Upserts thread messages by id.
   * Inserts new messages; updates existing rows (by id) with parts, metadata, role, updated_at.
   * PostgreSQL only.
   */
  async saveMessages(data: ThreadMessage[]): Promise<void> {
    const now = new Date().toISOString();
    const threadId = data[0]?.thread_id;
    if (!threadId) {
      throw new Error("thread_id is required when creating multiple messages");
    }
    // Deduplicate by id - PostgreSQL ON CONFLICT cannot affect same row twice in one INSERT.
    // Also detect duplicate ids with conflicting thread_ids to reject corrupt batches early.
    const byId = new Map<string, ThreadMessage>();
    for (const m of data) {
      const existing = byId.get(m.id);
      if (existing && existing.thread_id !== m.thread_id) {
        throw new Error(
          `Duplicate message id "${m.id}" with conflicting thread_ids: "${existing.thread_id}" vs "${m.thread_id}"`,
        );
      }
      byId.set(m.id, m);
    }
    const unique = [...byId.values()];
    // Validate all messages target the same thread to prevent data corruption.
    const mismatchedMessage = unique.find((m) => m.thread_id !== threadId);
    if (mismatchedMessage) {
      throw new Error(
        `All messages must target the same thread. Expected thread_id "${threadId}", but message "${mismatchedMessage.id}" has thread_id "${mismatchedMessage.thread_id}"`,
      );
    }
    const rows = unique.map((message) => ({
      id: message.id,
      thread_id: threadId,
      metadata: message.metadata ? JSON.stringify(message.metadata) : null,
      parts: JSON.stringify(message.parts),
      role: message.role,
      created_at: message.created_at ?? now,
      updated_at: now,
    }));

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("thread_messages")
        .values(rows)
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) => ({
            metadata: eb.ref("excluded.metadata"),
            parts: eb.ref("excluded.parts"),
            role: eb.ref("excluded.role"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
      await trx
        .updateTable("threads")
        .set({ updated_at: now })
        .where("id", "=", threadId)
        .execute();
    });
  }

  async listMessages(
    threadId: string,
    options?: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    },
  ): Promise<{ messages: ThreadMessage[]; total: number }> {
    const sort = options?.sort ?? "asc";
    // Order by created_at first, then by id as a tiebreaker for stable ordering
    // when messages have identical timestamps (e.g., batched inserts).
    let query = this.db
      .selectFrom("thread_messages")
      .selectAll()
      .where("thread_id", "=", threadId)
      .orderBy("created_at", sort)
      .orderBy("id", sort);

    const countQuery = this.db
      .selectFrom("thread_messages")
      .select((eb) => eb.fn.count("id").as("count"))
      .where("thread_id", "=", threadId);

    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.offset) {
      query = query.offset(options.offset);
    }

    const [rows, countResult] = await Promise.all([
      query.execute(),
      countQuery.executeTakeFirst(),
    ]);

    return {
      messages: rows.map((row) => this.messageFromDbRow(row)),
      total: Number(countResult?.count || 0),
    };
  }

  // ==========================================================================
  // Thread Member Operations
  // ==========================================================================

  async addMember(
    threadId: string,
    userId: string,
    addedBy: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("thread_members")
      .values({
        thread_id: threadId,
        user_id: userId,
        added_by: addedBy,
        added_at: now,
      })
      .onConflict((oc) => oc.columns(["thread_id", "user_id"]).doNothing())
      .execute();
  }

  async removeMember(threadId: string, userId: string): Promise<void> {
    await this.db
      .deleteFrom("thread_members")
      .where("thread_id", "=", threadId)
      .where("user_id", "=", userId)
      .execute();
  }

  async listMembers(threadId: string): Promise<ThreadMember[]> {
    const rows = await this.db
      .selectFrom("thread_members")
      .selectAll()
      .where("thread_id", "=", threadId)
      .orderBy("added_at", "asc")
      .execute();

    return rows.map((row) => ({
      thread_id: row.thread_id,
      user_id: row.user_id,
      added_by: row.added_by,
      added_at: toIsoString(row.added_at as Date | string),
    }));
  }

  async isMember(threadId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("thread_members")
      .select("user_id")
      .where("thread_id", "=", threadId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return !!row;
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  private threadFromDbRow(row: {
    id: string;
    organization_id: string;
    title: string;
    description: string | null;
    status: string;
    created_at: Date | string;
    updated_at: Date | string;
    created_by: string;
    updated_by: string | null;
    hidden: boolean | number | null;
    is_shared?: boolean;
  }): Thread {
    return {
      id: row.id,
      organization_id: row.organization_id,
      title: row.title,
      description: row.description,
      status: row.status as ThreadStatus,
      created_at: toIsoString(row.created_at),
      updated_at: toIsoString(row.updated_at),
      created_by: row.created_by,
      updated_by: row.updated_by,
      hidden: !!row.hidden,
      is_shared: row.is_shared ?? false,
    };
  }

  private messageFromDbRow(row: {
    id: string;
    thread_id: string;
    metadata: string | null;
    parts: string | Record<string, unknown>[];
    role: "user" | "assistant" | "system";
    created_at: Date | string;
    updated_at: Date | string;
  }): ThreadMessage {
    let metadata: Record<string, unknown> | undefined;
    let parts: ThreadMessage["parts"];

    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : undefined;
    } catch (e) {
      console.error(
        `Failed to parse metadata for message ${row.id}:`,
        row.metadata,
        e,
      );
      metadata = undefined;
    }

    try {
      parts = typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts;
    } catch (e) {
      console.error(
        `Failed to parse parts for message ${row.id}:`,
        row.parts,
        e,
      );
      // Return empty parts array to prevent crashes, but log for debugging
      parts = [];
    }

    return {
      id: row.id,
      thread_id: row.thread_id,
      metadata,
      parts,
      role: row.role,
      created_at: toIsoString(row.created_at),
      updated_at: toIsoString(row.updated_at),
    };
  }
}
