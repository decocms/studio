/**
 * Thread Storage Implementation
 *
 * Handles CRUD operations for chat threads and messages using Kysely (database-agnostic).
 * Threads are organization-scoped, messages are thread-scoped.
 */

import { sql, type Kysely } from "kysely";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import { DEFAULT_THREAD_TITLE } from "@/api/routes/decopilot/constants";
import type {
  ThreadRuntimePin,
  ThreadRuntimePinResult,
  ThreadStoragePort,
  ThreadUpdateData,
} from "./ports";
import { SqlThreadMessagePartStorage } from "./thread-message-parts";
import type {
  Database,
  Thread,
  ThreadMessage,
  ThreadMetadata,
  ThreadStatus,
} from "./types";

function toIsoString(v: Date | string): string {
  return typeof v === "string" ? v : v.toISOString();
}

/** Escapes LIKE/ILIKE wildcards so a free-text `search` term matches a literal substring. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
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

  /**
   * Rebind this storage to a different org id.
   * Called by `resolveOrgFromPath` middleware after the org is resolved from
   * the URL slug — studioContext is constructed eagerly, so when no `x-org-id`
   * header is present the storage starts with `organizationId = undefined`
   * and must be updated in-place once the path-resolved org is known.
   */
  setOrganizationId(organizationId: string | undefined): void {
    this.organizationId = organizationId;
  }

  /**
   * Currently bound organization id (or undefined). Exposed primarily for
   * tests that assert middleware rebinds the storage correctly.
   */
  getOrganizationId(): string | undefined {
    return this.organizationId;
  }

  create(data: Partial<Thread>): Promise<Thread & { isNew: boolean }> {
    const orgId = this.requireOrg();
    return this.inner.create({ ...data, organization_id: orgId });
  }

  get(id: string): Promise<Thread | null> {
    return this.inner.get(id, this.requireOrg());
  }

  update(id: string, data: ThreadUpdateData): Promise<Thread> {
    return this.inner.update(id, this.requireOrg(), data);
  }

  pinRuntimeIfUnset(
    id: string,
    pin: ThreadRuntimePin,
  ): Promise<ThreadRuntimePinResult> {
    return this.inner.pinRuntimeIfUnset(id, this.requireOrg(), pin);
  }

  completeRunIfNotCompleted(id: string): Promise<Thread | null> {
    return this.inner.completeRunIfNotCompleted(id, this.requireOrg());
  }

  markRunFailed(
    id: string,
    reason: string,
    kind: string,
  ): Promise<Thread | null> {
    return this.inner.markRunFailed(id, this.requireOrg(), reason, kind);
  }

  failIfNotTerminal(
    id: string,
    reason: string,
    kind: string,
  ): Promise<Thread | null> {
    return this.inner.failIfNotTerminal(id, this.requireOrg(), reason, kind);
  }

  requiresActionIfInProgress(id: string): Promise<Thread | null> {
    return this.inner.requiresActionIfInProgress(id, this.requireOrg());
  }

  forceFailIfInProgress(
    id: string,
    expectedFenceToken?: string | null,
  ): Promise<boolean> {
    return this.inner.forceFailIfInProgress(
      id,
      this.requireOrg(),
      expectedFenceToken,
    );
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
      includeArchived?: boolean;
      hasTrigger?: boolean;
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

  findLastUsedByVirtualMcpIds(
    virtualMcpIds: string[],
  ): Promise<Map<string, { last_used_at: string; last_used_by: string }>> {
    return this.inner.findLastUsedByVirtualMcpIds(
      this.requireOrg(),
      virtualMcpIds,
    );
  }

  /** Stamp `last_progress_at = now()` (progress-liveness heartbeat). */
  bumpProgress(taskId: string): Promise<void> {
    return this.inner.bumpProgress(taskId, this.requireOrg());
  }

  /** Read progress-liveness columns (epoch-ms). */
  getProgress(taskId: string): Promise<{
    lastProgressAt: number | null;
    runStartedAt: number | null;
  } | null> {
    return this.inner.getProgress(taskId, this.requireOrg());
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

  listWithLastMessage(options: {
    limit: number;
    createdBy?: string;
    lastMessageRole: "assistant" | "user";
  }): Promise<Array<{ thread: Thread; lastMessage: ThreadMessage }>> {
    return this.inner.listWithLastMessage(this.requireOrg(), options);
  }

  /**
   * Stream-of-record part storage on the same connection. The v2 read path
   * folds these into history. Access is org-guarded by the caller's prior
   * org-scoped thread fetch (R23) — the part storage itself is not org-bound.
   */
  messageParts(): SqlThreadMessagePartStorage {
    return this.inner.messageParts();
  }

  /**
   * Current fence token for a run (thread id == run id today). Returns null
   * if no fence has been minted, which means any token (including null) is
   * accepted by `fenceMatches`.
   */
  getRunFence(threadId: string): Promise<string | null> {
    return this.inner.getRunFence(threadId);
  }

  /**
   * Set (or clear) the fence token for a run. Minted by `prepareRun` after
   * the run is claimed (Phase B). Cleared by the ingest finish handler so
   * late-arriving duplicate appends are rejected with 409.
   */
  setRunFence(threadId: string, token: string | null): Promise<void> {
    return this.inner.setRunFence(threadId, token);
  }

  /**
   * Stamp `cancel_requested_at = now()` for the given thread (Phase C).
   * Org-scoped: only updates rows matching both id AND organization_id.
   */
  setCancelRequested(threadId: string, organizationId: string): Promise<void> {
    return this.inner.setCancelRequested(threadId, organizationId);
  }

  /**
   * Read `cancel_requested_at` for a thread by id (not org-scoped, mirrors
   * `getRunFence` which is also unscoped — callers guard via ownership check).
   */
  getCancelRequestedAt(threadId: string): Promise<Date | null> {
    return this.inner.getCancelRequestedAt(threadId);
  }

  /** Clear `cancel_requested_at` (set to NULL) for a thread by id. */
  clearCancelRequested(threadId: string): Promise<void> {
    return this.inner.clearCancelRequested(threadId);
  }

  /**
   * Monotonically advance `run_acked_seq` for a run.
   * Only writes when the new value is strictly greater than the stored floor.
   * `fenceToken` is accepted for interface parity; the floor is fence-agnostic
   * at the storage level — a new fence epoch resets the floor at the call site.
   */
  bumpAckedSeq(id: string, fenceToken: string, ackSeq: number): Promise<void> {
    return this.inner.bumpAckedSeq(id, this.requireOrg(), fenceToken, ackSeq);
  }

  /**
   * Read the current `run_acked_seq` floor for a run.
   * Returns 0 when the column is null (no chunks published yet).
   */
  getAckedSeq(id: string): Promise<number> {
    return this.inner.getAckedSeq(id, this.requireOrg());
  }
}

// ============================================================================
// Thread Storage Implementation
// ============================================================================

export class SqlThreadStorage implements ThreadStoragePort {
  constructor(private db: Kysely<Database>) {}

  /**
   * Stream-of-record part storage backed by the same connection. Used by the
   * v2 read path (`Memory.loadHistory`) to fold `thread_message_parts`.
   * Part rows are not org-scoped here — callers MUST guard access with an
   * org-scoped thread fetch first (the R23 predicate).
   */
  messageParts(): SqlThreadMessagePartStorage {
    return new SqlThreadMessagePartStorage(this.db);
  }

  // ==========================================================================
  // Thread Operations
  // ==========================================================================

  async create(data: Partial<Thread>): Promise<Thread & { isNew: boolean }> {
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
      virtual_mcp_id: data.virtual_mcp_id ?? "",
      branch: data.branch ?? null,
      sandbox_provider_kind: data.sandbox_provider_kind ?? null,
      harness_id: data.harness_id ?? null,
      created_at: now,
      updated_at: now,
      created_by: data.created_by,
      updated_by: data.updated_by ?? null,
      ...(data.message_storage_version !== undefined
        ? { message_storage_version: data.message_storage_version }
        : {}),
      ...(data.metadata !== undefined
        ? { metadata: JSON.stringify(data.metadata) }
        : {}),
    };

    const inserted = await this.db
      .insertInto("threads")
      .values(row)
      .onConflict((oc) => oc.column("id").doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      return { ...this.threadFromDbRow(inserted), isNew: true };
    }

    // Conflict — another caller already inserted this id. Return the row that won.
    const existing = await this.db
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", data.organization_id)
      .executeTakeFirstOrThrow();

    return { ...this.threadFromDbRow(existing), isNew: false };
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
    data: ThreadUpdateData,
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
    if (data.last_progress_at !== undefined) {
      updateData.last_progress_at = data.last_progress_at;
    }
    if (data.failure_reason !== undefined) {
      updateData.failure_reason = data.failure_reason;
    }
    if (data.failure_kind !== undefined) {
      updateData.failure_kind = data.failure_kind;
    }
    if (data.metadata !== undefined) {
      updateData.metadata = JSON.stringify(data.metadata);
    }
    if (data.branch !== undefined) {
      updateData.branch = data.branch;
    }
    if (data.virtual_mcp_id !== undefined) {
      updateData.virtual_mcp_id = data.virtual_mcp_id;
    }
    if (data.sandbox_provider_kind !== undefined) {
      updateData.sandbox_provider_kind = data.sandbox_provider_kind;
    }
    if (data.harness_id !== undefined) {
      updateData.harness_id = data.harness_id;
    }
    if (data.message_storage_version !== undefined) {
      updateData.message_storage_version = data.message_storage_version;
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

  async pinRuntimeIfUnset(
    id: string,
    organizationId: string,
    pin: ThreadRuntimePin,
  ): Promise<ThreadRuntimePinResult> {
    const row = await this.db
      .updateTable("threads")
      .set({
        harness_id: pin.harnessId,
        sandbox_provider_kind: sql<string | null>`coalesce(${sql.ref(
          "sandbox_provider_kind",
        )}, ${pin.sandboxProviderKind})`,
        branch: sql<string | null>`coalesce(${sql.ref("branch")}, ${
          pin.branch
        })`,
        updated_at: new Date().toISOString(),
        ...(pin.messageStorageVersion !== undefined
          ? { message_storage_version: pin.messageStorageVersion }
          : {}),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("harness_id", "is", null)
      .where((eb) =>
        pin.sandboxProviderKind === null
          ? eb("sandbox_provider_kind", "is", null)
          : eb.or([
              eb("sandbox_provider_kind", "is", null),
              eb("sandbox_provider_kind", "=", pin.sandboxProviderKind),
            ]),
      )
      .returningAll()
      .executeTakeFirst();

    if (row) {
      return { thread: this.threadFromDbRow(row), claimed: true };
    }

    return {
      thread: await this.get(id, organizationId),
      claimed: false,
    };
  }

  async completeRunIfNotCompleted(
    id: string,
    organizationId: string,
  ): Promise<Thread | null> {
    const rows = await this.db
      .updateTable("threads")
      .set({
        status: "completed",
        run_owner_pod: null,
        run_config: null,
        run_started_at: null,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("status", "=", "in_progress")
      .returningAll()
      .execute();

    const row = rows[0];
    return row ? this.threadFromDbRow(row) : null;
  }

  async markRunFailed(
    id: string,
    organizationId: string,
    reason: string,
    kind: string,
  ): Promise<Thread | null> {
    const rows = await this.db
      .updateTable("threads")
      .set({
        status: "failed",
        failure_reason: reason,
        failure_kind: kind,
        run_owner_pod: null,
        run_config: null,
        run_started_at: null,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("status", "=", "in_progress")
      .returningAll()
      .execute();

    const row = rows[0];
    return row ? this.threadFromDbRow(row) : null;
  }

  /**
   * `markRunFailed`, widened to also take a thread parked on `requires_action`.
   *
   * That status is a PAUSE, not a terminal state — a run waiting on a
   * `user_ask`. Every automatic writer must leave it alone (the human owns it),
   * which is why `markRunFailed` is guarded on `in_progress` only. But a
   * deliberate user action that abandons the run has to be able to close it out:
   * `requires_action` counts as non-terminal everywhere it matters
   * (`TERMINAL_THREAD_STATUSES`, `shouldAdvanceToReview`), so leaving one behind
   * means the task can never auto-advance again, no matter how many later runs
   * succeed.
   *
   * Still a conditional UPDATE, so it cannot clobber a genuinely terminal row
   * that settled between the caller's read and this write.
   */
  async failIfNotTerminal(
    id: string,
    organizationId: string,
    reason: string,
    kind: string,
  ): Promise<Thread | null> {
    const rows = await this.db
      .updateTable("threads")
      .set({
        status: "failed",
        failure_reason: reason,
        failure_kind: kind,
        run_owner_pod: null,
        run_config: null,
        run_started_at: null,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("status", "in", ["in_progress", "requires_action"])
      .returningAll()
      .execute();

    const row = rows[0];
    return row ? this.threadFromDbRow(row) : null;
  }

  async requiresActionIfInProgress(
    id: string,
    organizationId: string,
  ): Promise<Thread | null> {
    const rows = await this.db
      .updateTable("threads")
      .set({
        status: "requires_action",
        // run_owner_pod kept set: requires_action is a pause, not terminal state — run resumes after tool approval
        run_config: null,
        run_started_at: null,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("status", "=", "in_progress")
      .returningAll()
      .execute();

    const row = rows[0];
    return row ? this.threadFromDbRow(row) : null;
  }

  async forceFailIfInProgress(
    id: string,
    organizationId: string,
    expectedFenceToken?: string | null,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    let query = this.db
      .updateTable("threads")
      .set({ status: "failed", updated_at: now })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("status", "=", "in_progress");
    // Fence-scope the force-fail to the run being cancelled: a follow-up turn
    // sent while this (cross-pod, fire-and-forget) cancel is still settling
    // has already minted a NEW fence and re-set the thread `in_progress`, and
    // must NOT be force-failed by the prior turn's cancel. When no fence is
    // supplied (legacy callers, or a run that never persisted one) the guard
    // is skipped, preserving the prior unconditional behavior.
    if (expectedFenceToken != null) {
      query = query.where("run_fence_token", "=", expectedFenceToken);
    }
    const result = await query.executeTakeFirst();

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
      includeArchived?: boolean;
      hasTrigger?: boolean;
    },
  ): Promise<{ threads: Thread[]; total: number }> {
    const archived = options?.includeArchived === true;
    let query = this.db
      .selectFrom("threads")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("hidden", "=", archived)
      .orderBy("updated_at", "desc");

    if (createdBy) {
      query = query.where("created_by", "=", createdBy);
    }
    const virtualMcpFilter = options?.virtualMcpId ?? options?.agentId;
    if (virtualMcpFilter) {
      query = query.where("virtual_mcp_id", "=", virtualMcpFilter);
    }
    if (options?.hasTrigger === true) {
      query = query.where("trigger_id", "is not", null);
    } else if (options?.hasTrigger === false) {
      query = query.where("trigger_id", "is", null);
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
      query = query.where(
        "title",
        "ilike",
        `%${escapeLikePattern(options.search)}%`,
      );
    }
    if (options?.status) {
      query = query.where("status", "=", options.status as ThreadStatus);
    }

    let countQuery = this.db
      .selectFrom("threads")
      .select((eb) => eb.fn.count("id").as("count"))
      .where("organization_id", "=", organizationId)
      .where("hidden", "=", archived);

    if (createdBy) {
      countQuery = countQuery.where("created_by", "=", createdBy);
    }
    if (virtualMcpFilter) {
      countQuery = countQuery.where("virtual_mcp_id", "=", virtualMcpFilter);
    }
    if (options?.hasTrigger === true) {
      countQuery = countQuery.where("trigger_id", "is not", null);
    } else if (options?.hasTrigger === false) {
      countQuery = countQuery.where("trigger_id", "is", null);
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
      countQuery = countQuery.where(
        "title",
        "ilike",
        `%${escapeLikePattern(options.search)}%`,
      );
    }
    if (options?.status) {
      countQuery = countQuery.where(
        "status",
        "=",
        options.status as ThreadStatus,
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

  async findLastUsedByVirtualMcpIds(
    organizationId: string,
    virtualMcpIds: string[],
  ): Promise<Map<string, { last_used_at: string; last_used_by: string }>> {
    const result = new Map<
      string,
      { last_used_at: string; last_used_by: string }
    >();
    if (virtualMcpIds.length === 0) return result;

    const rows = await this.db
      .selectFrom("threads")
      .distinctOn("virtual_mcp_id")
      .select(["virtual_mcp_id", "created_by", "created_at"])
      .where("organization_id", "=", organizationId)
      .where("virtual_mcp_id", "in", virtualMcpIds)
      .orderBy("virtual_mcp_id")
      .orderBy("created_at", "desc")
      .execute();

    for (const row of rows) {
      result.set(row.virtual_mcp_id, {
        last_used_at: toIsoString(row.created_at),
        last_used_by: row.created_by,
      });
    }
    return result;
  }

  /**
   * Last N threads whose most recent `thread_messages` row has the given
   * `lastMessageRole`. Backs the "Suggested actions" cards on the Tasks
   * panel — `assistant` for the primary set (AI is waiting on the user),
   * `user` for the fallback set (user wrote last) used to fill the panel
   * when the primary set is short.
   *
   * One round-trip: a LATERAL subquery picks each thread's last message
   * (created_at DESC, id DESC for stable tiebreak), then the outer query
   * keeps only the rows whose last message matches the requested role.
   * Ordered by the last-message timestamp.
   */
  async listWithLastMessage(
    organizationId: string,
    options: {
      limit: number;
      createdBy?: string;
      lastMessageRole: "assistant" | "user";
    },
  ): Promise<Array<{ thread: Thread; lastMessage: ThreadMessage }>> {
    let query = this.db
      .selectFrom("threads as t")
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom("thread_messages as m")
            .selectAll()
            .whereRef("m.thread_id", "=", "t.id")
            .orderBy("m.created_at", "desc")
            .orderBy("m.id", "desc")
            .limit(1)
            .as("lm"),
        (join) => join.onTrue(),
      )
      .selectAll("t")
      .select([
        "lm.id as lm_id",
        "lm.thread_id as lm_thread_id",
        "lm.metadata as lm_metadata",
        "lm.parts as lm_parts",
        "lm.role as lm_role",
        "lm.created_at as lm_created_at",
        "lm.updated_at as lm_updated_at",
      ])
      .where("t.organization_id", "=", organizationId)
      .where("t.hidden", "=", false)
      .where("lm.role", "=", options.lastMessageRole)
      .orderBy("lm.created_at", "desc")
      .limit(options.limit);

    if (options.createdBy) {
      query = query.where("t.created_by", "=", options.createdBy);
    }

    const rows = await query.execute();

    return rows.map((row) => ({
      thread: this.threadFromDbRow(row),
      lastMessage: this.messageFromDbRow({
        id: row.lm_id,
        thread_id: row.lm_thread_id,
        // `thread_messages.metadata` is `string | null`. Kysely's inference
        // unions it with `threads.metadata` (ThreadMetadata) because both
        // tables expose a `metadata` column under the same join row — the
        // values are unrelated, so we narrow back to the messages shape.
        metadata: row.lm_metadata as string | null,
        parts: row.lm_parts as string | Record<string, unknown>[],
        role: row.lm_role,
        created_at: row.lm_created_at,
        updated_at: row.lm_updated_at,
      }),
    }));
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

  async bumpProgress(taskId: string, organizationId: string): Promise<void> {
    // Single-column heartbeat write — intentionally does NOT touch
    // `updated_at` (that's the user-facing "last activity" timestamp; a
    // per-chunk bump would churn the thread list ordering). `now()` is
    // evaluated server-side so it's monotonic with the DB clock the reaper
    // reads against.
    await this.db
      .updateTable("threads")
      .set({ last_progress_at: sql`now()` })
      .where("id", "=", taskId)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  async getProgress(
    taskId: string,
    organizationId: string,
  ): Promise<{
    lastProgressAt: number | null;
    runStartedAt: number | null;
  } | null> {
    const row = await this.db
      .selectFrom("threads")
      .select(["last_progress_at", "run_started_at"])
      .where("id", "=", taskId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    if (!row) return null;
    const toMs = (v: Date | string | null | undefined): number | null => {
      if (v == null) return null;
      const ms = (v instanceof Date ? v : new Date(v)).getTime();
      return Number.isNaN(ms) ? null : ms;
    };
    return {
      lastProgressAt: toMs(row.last_progress_at),
      runStartedAt: toMs(row.run_started_at),
    };
  }

  /** Current fence token for a run (thread id == run id today). */
  async getRunFence(threadId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("threads")
      .select("run_fence_token")
      .where("id", "=", threadId)
      .executeTakeFirst();
    return row?.run_fence_token ?? null;
  }

  /**
   * Set (or clear) the fence token. Called exactly once per turn-start, before
   * any chunks are ingested. Atomically resets `run_acked_seq` to NULL so the
   * new fence epoch always starts with a clean floor — preventing a prior
   * turn's ack high-water mark from causing `RelaySessionImpl.push()` to drop
   * the new turn's early chunks (cross-turn chunk loss bug).
   *
   * When CLAIMING a turn (token non-null), also resets `status` to
   * `in_progress`. `runId === threadId`, so the run row is shared across every
   * turn of a thread, and the consume step is the SOLE terminal-status writer
   * whose entry guard returns early on a terminal status. Without this reset a
   * second turn inherits the PRIOR turn's terminal status (`completed` /
   * `requires_action`), so its consume step short-circuits and the turn renders
   * "No response was generated". Resetting here — atomically with the new fence
   * — re-arms the run for this turn (mirrors the per-turn `(runId,fenceToken)`
   * message-id namespacing: turn-stable runId needs an explicit per-turn reset).
   * Clearing the fence (token null, teardown) leaves status untouched.
   */
  async setRunFence(threadId: string, token: string | null): Promise<void> {
    await this.db
      .updateTable("threads")
      .set(
        token === null
          ? { run_fence_token: null, run_acked_seq: null }
          : {
              run_fence_token: token,
              run_acked_seq: null,
              status: "in_progress",
            },
      )
      .where("id", "=", threadId)
      .execute();
  }

  /**
   * Stamp `cancel_requested_at = now()` for the given thread (Phase C).
   * Org-scoped: only updates rows matching both id AND organization_id.
   */
  async setCancelRequested(
    threadId: string,
    organizationId: string,
  ): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({ cancel_requested_at: sql`now()` })
      .where("id", "=", threadId)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  /**
   * Read `cancel_requested_at` for a thread by id.
   * Not org-scoped — mirrors `getRunFence` (callers guard via ownership check).
   */
  async getCancelRequestedAt(threadId: string): Promise<Date | null> {
    const row = await this.db
      .selectFrom("threads")
      .select("cancel_requested_at")
      .where("id", "=", threadId)
      .executeTakeFirst();
    const v = row?.cancel_requested_at;
    if (v == null) return null;
    return v instanceof Date ? v : new Date(v);
  }

  /** Clear `cancel_requested_at` (set to NULL) for a thread by id. */
  async clearCancelRequested(threadId: string): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({ cancel_requested_at: null })
      .where("id", "=", threadId)
      .execute();
  }

  /**
   * Monotonically advance `run_acked_seq` for a run.
   *
   * Uses a conditional UPDATE so the value only ever increases — concurrent
   * calls from multiple replays are safe. `fenceToken` is accepted for
   * interface parity; the fence-epoch reset is performed atomically by
   * `setRunFence` at turn-start (which also nulls `run_acked_seq`), so any
   * subsequent `bumpAckedSeq` call within the same fence epoch is always
   * advancing from the correct (zero) baseline.
   */
  async bumpAckedSeq(
    id: string,
    organizationId: string,
    _fenceToken: string,
    ackSeq: number,
  ): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({ run_acked_seq: ackSeq })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where((eb) =>
        eb.or([
          eb("run_acked_seq", "is", null),
          eb("run_acked_seq", "<", ackSeq),
        ]),
      )
      .execute();
  }

  /**
   * Read the current `run_acked_seq` floor for a run.
   * Returns 0 when the column is null (no chunks published yet).
   */
  async getAckedSeq(id: string, organizationId: string): Promise<number> {
    const row = await this.db
      .selectFrom("threads")
      .select("run_acked_seq")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return row?.run_acked_seq ?? 0;
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
    last_progress_at?: Date | string | null;
    virtual_mcp_id?: string | null;
    branch?: string | null;
    sandbox_provider_kind?: string | null;
    harness_id?: string | null;
    metadata?: ThreadMetadata | string | null;
    created_at: Date | string;
    updated_at: Date | string;
    created_by: string;
    updated_by: string | null;
    hidden: boolean | number | null;
    message_storage_version?: number | null;
    link_transport?: string | null;
  }): Thread {
    let metadata: ThreadMetadata = {};
    if (row.metadata != null) {
      if (typeof row.metadata === "string") {
        try {
          metadata = JSON.parse(row.metadata) as ThreadMetadata;
        } catch (e) {
          console.error(
            `Failed to parse metadata for thread ${row.id}:`,
            row.metadata,
            e,
          );
        }
      } else {
        metadata = row.metadata;
      }
    }

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
      last_progress_at: row.last_progress_at
        ? toIsoString(row.last_progress_at)
        : null,
      virtual_mcp_id: row.virtual_mcp_id ?? "",
      branch: row.branch ?? null,
      sandbox_provider_kind: row.sandbox_provider_kind ?? null,
      harness_id: row.harness_id ?? null,
      metadata,
      created_at: toIsoString(row.created_at),
      updated_at: toIsoString(row.updated_at),
      created_by: row.created_by,
      updated_by: row.updated_by ?? undefined,
      hidden: !!row.hidden,
      // Defaults to 1 (legacy) when the column is absent/null so existing
      // threads keep reading from `thread_messages`.
      message_storage_version: row.message_storage_version ?? 1,
      link_transport: row.link_transport ?? null,
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
