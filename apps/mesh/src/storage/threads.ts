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
    options?: {
      limit?: number;
      offset?: number;
      virtualMcpId?: string;
      startDate?: string;
      endDate?: string;
      search?: string;
      status?: string;
      agentId?: string;
    },
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
    taskId: string,
    options?: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    },
  ): Promise<{ messages: ThreadMessage[]; total: number }> {
    return this.inner.listMessages(taskId, this.requireOrg(), options);
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
      status: data.status ?? "in_progress",
      trigger_id: data.trigger_id ?? null,
      virtual_mcp_id: data.virtual_mcp_id ?? "",
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
    if (data.run_owner_pod !== undefined) {
      updateData.run_owner_pod = data.run_owner_pod;
    }
    if (data.run_config !== undefined) {
      updateData.run_config = data.run_config
        ? JSON.stringify(data.run_config)
        : null;
    }
    if (data.run_started_at !== undefined) {
      updateData.run_started_at = data.run_started_at;
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
    options?: {
      limit?: number;
      offset?: number;
      virtualMcpId?: string;
      startDate?: string;
      endDate?: string;
      search?: string;
      status?: string;
      agentId?: string;
    },
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
    if (options?.virtualMcpId) {
      query = query.where("virtual_mcp_id", "=", options.virtualMcpId);
    }
    if (options?.startDate) {
      // updated_at is stored as ISO text — string comparison is correct for ISO dates
      query = query.where(
        "updated_at",
        ">=",
        options.startDate as unknown as Date,
      );
    }
    if (options?.endDate) {
      query = query.where(
        "updated_at",
        "<=",
        options.endDate as unknown as Date,
      );
    }
    if (options?.search) {
      query = query.where("title", "ilike", `%${options.search}%`);
    }
    if (options?.status) {
      query = query.where("status", "=", options.status as ThreadStatus);
    }
    if (options?.agentId) {
      query = query.where("virtual_mcp_id", "=", options.agentId);
    }

    let countQuery = this.db
      .selectFrom("threads")
      .select((eb) => eb.fn.count("id").as("count"))
      .where("organization_id", "=", organizationId)
      .where("hidden", "=", false);

    if (createdBy) {
      countQuery = countQuery.where("created_by", "=", createdBy);
    }
    if (options?.virtualMcpId) {
      countQuery = countQuery.where(
        "virtual_mcp_id",
        "=",
        options.virtualMcpId,
      );
    }
    if (options?.startDate) {
      countQuery = countQuery.where(
        "updated_at",
        ">=",
        options.startDate as unknown as Date,
      );
    }
    if (options?.endDate) {
      countQuery = countQuery.where(
        "updated_at",
        "<=",
        options.endDate as unknown as Date,
      );
    }
    if (options?.search) {
      countQuery = countQuery.where("title", "ilike", `%${options.search}%`);
    }
    if (options?.status) {
      countQuery = countQuery.where(
        "status",
        "=",
        options.status as ThreadStatus,
      );
    }
    if (options?.agentId) {
      countQuery = countQuery.where("virtual_mcp_id", "=", options.agentId);
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
    const taskId = data[0]?.thread_id;
    if (!taskId) {
      throw new Error("thread_id is required when creating multiple messages");
    }
    const thread = await this.get(taskId, organizationId);
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
    const mismatchedMessage = unique.find((m) => m.thread_id !== taskId);
    if (mismatchedMessage) {
      throw new Error(
        `All messages must target the same thread. Expected thread_id "${taskId}", but message "${mismatchedMessage.id}" has thread_id "${mismatchedMessage.thread_id}"`,
      );
    }
    const rows = unique.map((message) => ({
      id: message.id,
      thread_id: taskId,
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
        .where("id", "=", taskId)
        .where("organization_id", "=", organizationId)
        .execute();
    });
  }

  async listMessages(
    taskId: string,
    organizationId: string,
    options?: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    },
  ): Promise<{ messages: ThreadMessage[]; total: number }> {
    const thread = await this.get(taskId, organizationId);
    if (!thread) {
      return { messages: [], total: 0 };
    }
    const sort = options?.sort ?? "asc";
    // Order by created_at first, then by id as a tiebreaker for stable ordering
    // when messages have identical timestamps (e.g., batched inserts).
    let query = this.db
      .selectFrom("thread_messages")
      .selectAll()
      .where("thread_id", "=", taskId)
      .orderBy("created_at", sort)
      .orderBy("id", sort);

    const countQuery = this.db
      .selectFrom("thread_messages")
      .select((eb) => eb.fn.count("id").as("count"))
      .where("thread_id", "=", taskId);

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
  // Cross-Org System Operations (not exposed via OrgScopedThreadStorage)
  // ==========================================================================

  async claimOrphanedRun(
    taskId: string,
    organizationId: string,
    podId: string,
  ): Promise<boolean> {
    // Claim any in-progress run not already owned by this pod.
    // Matches both orphaned (NULL) and stale-pod (different pod) runs.
    // Uses raw SQL for the OR because Kysely's eb.or with IS NULL + != can
    // behave unexpectedly on some PG drivers.
    const result = await this.db
      .updateTable("threads")
      .set({ run_owner_pod: podId, updated_at: new Date().toISOString() })
      .where("id", "=", taskId)
      .where("organization_id", "=", organizationId)
      .where("status", "=", "in_progress")
      .where(({ eb, or }) =>
        or([eb("run_owner_pod", "is", null), eb("run_owner_pod", "!=", podId)]),
      )
      .executeTakeFirst();
    return (result?.numUpdatedRows ?? 0n) > 0n;
  }

  async listOrphanedRuns(currentPodId: string): Promise<Thread[]> {
    const rows = await this.db
      .selectFrom("threads")
      .selectAll()
      .where("status", "=", "in_progress")
      .where("run_config", "is not", null)
      .where((eb) =>
        eb.or([
          eb("run_owner_pod", "is", null),
          eb("run_owner_pod", "!=", currentPodId),
        ]),
      )
      .orderBy("run_started_at", "asc")
      .limit(100)
      .execute();
    return rows.map((row) => this.threadFromDbRow(row));
  }

  async listOrphanedRunsByPod(deadPodId: string): Promise<Thread[]> {
    const rows = await this.db
      .selectFrom("threads")
      .selectAll()
      .where("status", "=", "in_progress")
      .where("run_config", "is not", null)
      .where("run_owner_pod", "=", deadPodId)
      .orderBy("run_started_at", "asc")
      .limit(100)
      .execute();
    return rows.map((row) => this.threadFromDbRow(row));
  }

  async claimRunStart(
    taskId: string,
    organizationId: string,
    data: Partial<Thread>,
    podId: string | null,
  ): Promise<boolean> {
    const now = new Date().toISOString();

    const updateData: Record<string, unknown> = { updated_at: now };
    if (data.status !== undefined) updateData.status = data.status;
    if (data.run_owner_pod !== undefined)
      updateData.run_owner_pod = data.run_owner_pod;
    if (data.run_config !== undefined) {
      updateData.run_config = data.run_config
        ? JSON.stringify(data.run_config)
        : null;
    }
    if (data.run_started_at !== undefined)
      updateData.run_started_at = data.run_started_at;

    // CAS: only claim if not already running on a different pod
    const result = await this.db
      .updateTable("threads")
      .set(updateData)
      .where("id", "=", taskId)
      .where("organization_id", "=", organizationId)
      .where(({ eb, or }) =>
        or([
          // Not currently in_progress → fresh start
          eb("status", "!=", "in_progress"),
          // Orphan → null pod
          eb("run_owner_pod", "is", null),
          // Same pod restart
          ...(podId ? [eb("run_owner_pod", "=", podId)] : []),
        ]),
      )
      .executeTakeFirst();

    return (result?.numUpdatedRows ?? 0n) > 0n;
  }

  async orphanRunsByPod(podId: string): Promise<string[]> {
    const rows = await this.db
      .updateTable("threads")
      .set({ run_owner_pod: null, updated_at: new Date().toISOString() })
      .where("run_owner_pod", "=", podId)
      .where("status", "=", "in_progress")
      .returning("id")
      .execute();
    return rows.map((r) => r.id);
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
    run_owner_pod?: string | null;
    run_config?: Record<string, unknown> | null;
    run_started_at?: Date | string | null;
    virtual_mcp_id?: string | null;
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
      run_owner_pod: row.run_owner_pod ?? null,
      run_config: row.run_config ?? null,
      run_started_at: row.run_started_at
        ? toIsoString(row.run_started_at)
        : null,
      virtual_mcp_id: row.virtual_mcp_id ?? "",
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
