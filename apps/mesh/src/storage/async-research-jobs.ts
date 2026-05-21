/**
 * Async Research Jobs Storage
 *
 * Backs the `web_search` async-research path (Gemini Deep Research et al).
 *
 * Each row is the full lifecycle of one provider job:
 *   pending → polling → {completed | failed | cancelled | abandoned}
 *
 * Rows are never deleted. The DB is the answer to "what happened to this
 * customer's research job?" — one `SELECT * FROM async_research_jobs WHERE
 * thread_id = ? ORDER BY created_at DESC` is the entire debugging story.
 *
 * Idempotency on (organization_id, tool_call_id) — DBOS replays the same
 * tool_call_id, so `upsertPending` either inserts a new row or returns the
 * existing one. The runtime never spawns duplicate provider jobs for the
 * same tool call.
 */

import { sql, type Kysely } from "kysely";
import type { AsyncResearchJobStoragePort } from "./ports";
import type {
  AsyncResearchJob,
  AsyncResearchJobCitation,
  AsyncResearchJobTable,
  Database,
} from "./types";

function toIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : v.toISOString();
}

/**
 * Deterministic id for the seed assistant message we write next to a
 * polling row. Derived from the tool call id so we can find the row to
 * delete on terminal transitions without an extra lookup.
 */
function stubMessageId(toolCallId: string): string {
  return `msg_async_stub_${toolCallId}`;
}

/**
 * Delete the seed message inside a transaction. Safe no-op if absent —
 * a job can fail at submit time (before the stub was written) and we
 * still want the terminal transition to succeed.
 */
async function deleteStubMessage(
  trx: Kysely<Database>,
  toolCallId: string,
): Promise<void> {
  await trx
    .deleteFrom("thread_messages")
    .where("id", "=", stubMessageId(toolCallId))
    .execute();
}

function parseCitations(
  raw: AsyncResearchJobCitation[] | string | null | undefined,
): AsyncResearchJobCitation[] | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as AsyncResearchJobCitation[];
  } catch {
    return null;
  }
}

function rowToEntity(
  row: {
    [K in keyof AsyncResearchJobTable]: unknown;
  },
): AsyncResearchJob {
  return {
    id: row.id as string,
    interactionId: (row.interaction_id as string | null) ?? null,
    toolCallId: row.tool_call_id as string,
    organizationId: row.organization_id as string,
    threadId: row.thread_id as string,
    messageId: (row.message_id as string | null) ?? null,
    provider: row.provider as string,
    modelId: row.model_id as string,
    query: row.query as string,
    status: row.status as AsyncResearchJob["status"],
    attempts: (row.attempts as number) ?? 0,
    lastPolledAt: toIso(row.last_polled_at as Date | string | null),
    lastError: (row.last_error as string | null) ?? null,
    inputTokens: (row.input_tokens as number | null) ?? null,
    outputTokens: (row.output_tokens as number | null) ?? null,
    citations: parseCitations(
      row.citations as AsyncResearchJobCitation[] | string | null,
    ),
    resultUri: (row.result_uri as string | null) ?? null,
    resultPreview: (row.result_preview as string | null) ?? null,
    createdAt: toIso(row.created_at as Date | string) ?? "",
    updatedAt: toIso(row.updated_at as Date | string) ?? "",
    completedAt: toIso(row.completed_at as Date | string | null),
  };
}

// ============================================================================
// Org-scoped wrapper
// ============================================================================

/**
 * Org-scoped facade over `SqlAsyncResearchJobStorage`. Bakes the
 * organization id into the instance so call sites at the tool layer never
 * pass it explicitly — mirrors the `OrgScopedThreadStorage` pattern.
 */
export class OrgScopedAsyncResearchJobStorage {
  constructor(
    private inner: AsyncResearchJobStoragePort,
    private organizationId: string | undefined,
  ) {}

  private requireOrg(): string {
    if (!this.organizationId) {
      throw new Error(
        "OrgScopedAsyncResearchJobStorage: requires an authenticated organization",
      );
    }
    return this.organizationId;
  }

  setOrganizationId(organizationId: string | undefined): void {
    this.organizationId = organizationId;
  }

  upsertPending(input: {
    threadId: string;
    toolCallId: string;
    messageId?: string | null;
    provider: string;
    modelId: string;
    query: string;
  }): Promise<AsyncResearchJob> {
    return this.inner.upsertPending({
      organizationId: this.requireOrg(),
      ...input,
    });
  }

  findByToolCall(toolCallId: string): Promise<AsyncResearchJob | null> {
    return this.inner.findByToolCall(this.requireOrg(), toolCallId);
  }

  markPolling(
    toolCallId: string,
    interactionId: string,
    stub: { threadId: string; toolName: string; query: string },
  ): Promise<void> {
    return this.inner.markPolling(
      this.requireOrg(),
      toolCallId,
      interactionId,
      stub,
    );
  }

  recordPoll(toolCallId: string, lastError?: string | null): Promise<void> {
    return this.inner.recordPoll(this.requireOrg(), toolCallId, lastError);
  }

  markCompleted(
    toolCallId: string,
    result: {
      inputTokens: number;
      outputTokens: number;
      citations: AsyncResearchJobCitation[];
      resultUri: string | null;
      resultPreview: string;
    },
  ): Promise<void> {
    return this.inner.markCompleted(this.requireOrg(), toolCallId, result);
  }

  markFailed(toolCallId: string, error: string): Promise<void> {
    return this.inner.markFailed(this.requireOrg(), toolCallId, error);
  }

  markCancelled(toolCallId: string, reason?: string): Promise<void> {
    return this.inner.markCancelled(this.requireOrg(), toolCallId, reason);
  }
}

// ============================================================================
// Kysely-backed implementation
// ============================================================================

export class SqlAsyncResearchJobStorage implements AsyncResearchJobStoragePort {
  constructor(private db: Kysely<Database>) {}

  async upsertPending(input: {
    organizationId: string;
    threadId: string;
    toolCallId: string;
    messageId?: string | null;
    provider: string;
    modelId: string;
    query: string;
  }): Promise<AsyncResearchJob> {
    const now = new Date().toISOString();

    // ON CONFLICT DO NOTHING returns no row when the row already exists, so
    // we fall through to a plain SELECT in that case. The unique index on
    // (organization_id, tool_call_id) is what makes the conflict path the
    // resume path.
    const inserted = await this.db
      .insertInto("async_research_jobs")
      .values({
        organization_id: input.organizationId,
        thread_id: input.threadId,
        tool_call_id: input.toolCallId,
        message_id: input.messageId ?? null,
        provider: input.provider,
        model_id: input.modelId,
        query: input.query,
        status: "pending",
        attempts: 0,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["organization_id", "tool_call_id"]).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();

    if (inserted) return rowToEntity(inserted);

    const existing = await this.db
      .selectFrom("async_research_jobs")
      .selectAll()
      .where("organization_id", "=", input.organizationId)
      .where("tool_call_id", "=", input.toolCallId)
      .executeTakeFirstOrThrow();

    return rowToEntity(existing);
  }

  async findByToolCall(
    organizationId: string,
    toolCallId: string,
  ): Promise<AsyncResearchJob | null> {
    const row = await this.db
      .selectFrom("async_research_jobs")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("tool_call_id", "=", toolCallId)
      .executeTakeFirst();

    return row ? rowToEntity(row) : null;
  }

  async markPolling(
    organizationId: string,
    toolCallId: string,
    interactionId: string,
    stub: {
      threadId: string;
      toolName: string;
      query: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("async_research_jobs")
        .set({
          status: "polling",
          interaction_id: interactionId,
          last_polled_at: now,
          updated_at: now,
        })
        .where("organization_id", "=", organizationId)
        .where("tool_call_id", "=", toolCallId)
        .execute();

      // Stub assistant message — gives the AI SDK reader something to
      // seed from on browser refresh during the long polling window.
      // See port doc for the failure mode this prevents.
      await trx
        .insertInto("thread_messages")
        .values({
          id: stubMessageId(toolCallId),
          thread_id: stub.threadId,
          role: "assistant",
          parts: JSON.stringify([
            {
              type: `tool-${stub.toolName}`,
              toolCallId,
              state: "input-available",
              input: { query: stub.query },
            },
          ]),
          metadata: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    });
  }

  async recordPoll(
    organizationId: string,
    toolCallId: string,
    lastError?: string | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .updateTable("async_research_jobs")
      .set({
        attempts: sql`attempts + 1`,
        last_polled_at: now,
        // Use the passed-in value when given (including explicit null to
        // clear); leave the column alone when the param is undefined.
        ...(lastError !== undefined ? { last_error: lastError } : {}),
        updated_at: now,
      })
      .where("organization_id", "=", organizationId)
      .where("tool_call_id", "=", toolCallId)
      .execute();
  }

  async markCompleted(
    organizationId: string,
    toolCallId: string,
    result: {
      inputTokens: number;
      outputTokens: number;
      citations: AsyncResearchJobCitation[];
      resultUri: string | null;
      resultPreview: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("async_research_jobs")
        .set({
          status: "completed",
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          citations: JSON.stringify(result.citations),
          result_uri: result.resultUri,
          result_preview: result.resultPreview,
          completed_at: now,
          updated_at: now,
        })
        .where("organization_id", "=", organizationId)
        .where("tool_call_id", "=", toolCallId)
        .execute();
      await deleteStubMessage(trx, toolCallId);
    });
  }

  async markFailed(
    organizationId: string,
    toolCallId: string,
    error: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("async_research_jobs")
        .set({
          status: "failed",
          last_error: error,
          completed_at: now,
          updated_at: now,
        })
        .where("organization_id", "=", organizationId)
        .where("tool_call_id", "=", toolCallId)
        .execute();
      await deleteStubMessage(trx, toolCallId);
    });
  }

  async markCancelled(
    organizationId: string,
    toolCallId: string,
    reason?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("async_research_jobs")
        .set({
          status: "cancelled",
          last_error: reason ?? null,
          completed_at: now,
          updated_at: now,
        })
        .where("organization_id", "=", organizationId)
        .where("tool_call_id", "=", toolCallId)
        .execute();
      await deleteStubMessage(trx, toolCallId);
    });
  }

  async sweepAbandoned(staleAfterMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const now = new Date().toISOString();
    return await this.db.transaction().execute(async (trx) => {
      // Pull the soon-to-be-abandoned rows first so we know which stub
      // messages to drop. SELECT + UPDATE in the same transaction keeps
      // the window where a row's status disagrees with its stub closed.
      const targets = await trx
        .selectFrom("async_research_jobs")
        .select(["tool_call_id"])
        .where("status", "in", ["pending", "polling"])
        .where("last_polled_at", "<", cutoff)
        .execute();
      if (targets.length === 0) return 0;

      const result = await trx
        .updateTable("async_research_jobs")
        .set({
          status: "abandoned",
          completed_at: now,
          updated_at: now,
          // Tag the reason so the audit trail explains why this row moved.
          last_error: sql`COALESCE(last_error, '') || ' [abandoned by sweeper]'`,
        })
        .where("status", "in", ["pending", "polling"])
        .where("last_polled_at", "<", cutoff)
        .execute();

      const stubIds = targets.map((t) => stubMessageId(t.tool_call_id));
      await trx
        .deleteFrom("thread_messages")
        .where("id", "in", stubIds)
        .execute();

      return Number(result[0]?.numUpdatedRows ?? 0n);
    });
  }
}
