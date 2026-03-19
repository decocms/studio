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
import type { Database, Thread, ThreadMessage, ThreadStatus } from "./types";

function toIsoString(v: Date | string): string {
  return typeof v === "string" ? v : v.toISOString();
}

// ============================================================================
// Org-Scoped Thread Storage (repository pattern)
// ============================================================================

/**
 * Organization-scoped thread storage wrapper.
 * Bakes organizationId into the instance — callers never pass org.
 * Use for per-request context where org is known at construction.
 *
 * Constructed eagerly for every request (org may be absent for unauthenticated
 * contexts). Any method call without a valid org throws immediately so misuse
 * surfaces at the call site rather than silently operating on `organization_id = ""`.
 */
export class OrgScopedThreadStorage {
  constructor(
    private inner: SqlThreadStorage,
    private organizationId: string | undefined,
  ) {}

  /** Throws if no org is bound; returns the validated org ID for use in method bodies. */
  private requireOrg(): string {
    if (!this.organizationId) {
      throw new Error(
        "OrgScopedThreadStorage: thread operations require an authenticated organization",
      );
    }
    return this.organizationId;
  }

  create(data: Partial<Thread>): Promise<Thread> {
    const orgId = this.requireOrg();
    return this.inner.create({ ...data, organization_id: orgId });
  }

  get(id: string): Promise<Thread | null> {
    return this.inner.get(id, this.requireOrg());
  }

  update(id: string, data: Partial<Thread>): Promise<Thread> {
    return this.inner.update(id, this.requireOrg(), data);
  }

  forceFailIfInProgress(id: string): Promise<boolean> {
    return this.inner.forceFailIfInProgress(id, this.requireOrg());
  }

  delete(id: string): Promise<void> {
    return this.inner.delete(id, this.requireOrg());
  }

  list(
    createdBy?: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ threads: Thread[]; total: number }> {
    return this.inner.list(this.requireOrg(), createdBy, options);
  }

  listByTriggerIds(
    triggerIds: string[],
    options?: { limit?: number; offset?: number },
  ): Promise<{ threads: Thread[]; total: number }> {
    return this.inner.listByTriggerIds(this.requireOrg(), triggerIds, options);
  }

  saveMessages(data: ThreadMessage[]): Promise<void> {
    return this.inner.saveMessages(data, this.requireOrg());
  }

  listMessages(
    threadId: string,
    options?: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    },
  ): Promise<{ messages: ThreadMessage[]; total: number }> {
    return this.inner.listMessages(threadId, this.requireOrg(), options);
  }
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
      trigger_id: data.trigger_id ?? null,
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

  async get(id: string, organizationId: string): Promise<Thread | null> {
    const row = await this.db
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    return row ? this.threadFromDbRow(row) : null;
  }

  async update(
    id: string,
    organizationId: string,
    data: Partial<Thread>,
  ): Promise<Thread> {
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
    if (data.context_start_message_id !== undefined) {
      updateData.context_start_message_id = data.context_start_message_id;
    }

    await this.db
      .updateTable("threads")
      .set(updateData)
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();

    const thread = await this.get(id, organizationId);
    if (!thread) {
      throw new Error("Thread not found after update");
    }

    return thread;
  }

  async forceFailIfInProgress(
    id: string,
    organizationId: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db
      .updateTable("threads")
      .set({ status: "failed", updated_at: now })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("status", "=", "in_progress")
      .executeTakeFirst();

    return (result.numUpdatedRows ?? BigInt(0)) > BigInt(0);
  }

  async delete(id: string, organizationId: string): Promise<void> {
    await this.db
      .deleteFrom("threads")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  async list(
    organizationId: string,
    createdBy?: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ threads: Thread[]; total: number }> {
    let query = this.db
      .selectFrom("threads")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("hidden", "=", false)

      .orderBy("updated_at", "desc");
    if (createdBy) {
      query = query.where("created_by", "=", createdBy);
    }
    let countQuery = this.db
      .selectFrom("threads")
      .select((eb) => eb.fn.count("id").as("count"))
      .where("organization_id", "=", organizationId)
      .where("hidden", "=", false);
    if (createdBy) {
      countQuery = countQuery.where("created_by", "=", createdBy);
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
      threads: rows.map((row) => this.threadFromDbRow(row)),
      total: Number(countResult?.count || 0),
    };
  }

  async listByTriggerIds(
    organizationId: string,
    triggerIds: string[],
    options?: { limit?: number; offset?: number },
  ): Promise<{ threads: Thread[]; total: number }> {
    if (triggerIds.length === 0) {
      return { threads: [], total: 0 };
    }

    let query = this.db
      .selectFrom("threads")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("hidden", "=", false)
      .where("trigger_id", "in", triggerIds)
      .orderBy("updated_at", "desc");

    const countQuery = this.db
      .selectFrom("threads")
      .select((eb) => eb.fn.count("id").as("count"))
      .where("organization_id", "=", organizationId)
      .where("hidden", "=", false)
      .where("trigger_id", "in", triggerIds);

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
      threads: rows.map((row) => this.threadFromDbRow(row)),
      total: Number(countResult?.count || 0),
    };
  }

  /**
   * Upserts thread messages by id.
   * Inserts new messages; updates existing rows (by id) with parts, metadata, role, updated_at.
   * PostgreSQL only.
   */
  async saveMessages(
    data: ThreadMessage[],
    organizationId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const threadId = data[0]?.thread_id;
    if (!threadId) {
      throw new Error("thread_id is required when creating multiple messages");
    }
    const thread = await this.get(threadId, organizationId);
    if (!thread) {
      throw new Error("Thread not found or access denied");
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
        .where("organization_id", "=", organizationId)
        .execute();
    });
  }

  async listMessages(
    threadId: string,
    organizationId: string,
    options?: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    },
  ): Promise<{ messages: ThreadMessage[]; total: number }> {
    const thread = await this.get(threadId, organizationId);
    if (!thread) {
      return { messages: [], total: 0 };
    }
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
  // Private Helper Methods
  // ==========================================================================

  private threadFromDbRow(row: {
    id: string;
    organization_id: string;
    title: string;
    description: string | null;
    status: string;
    trigger_id?: string | null;
    context_start_message_id?: string | null;
    created_at: Date | string;
    updated_at: Date | string;
    created_by: string;
    updated_by: string | null;
    hidden: boolean | number | null;
  }): Thread {
    return {
      id: row.id,
      organization_id: row.organization_id,
      title: row.title,
      description: row.description,
      status: row.status as ThreadStatus,
      trigger_id: row.trigger_id ?? null,
      context_start_message_id: row.context_start_message_id ?? null,
      created_at: toIsoString(row.created_at),
      updated_at: toIsoString(row.updated_at),
      created_by: row.created_by,
      updated_by: row.updated_by,
      hidden: !!row.hidden,
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
