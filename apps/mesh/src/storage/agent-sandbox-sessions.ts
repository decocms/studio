import { createHash } from "node:crypto";
import { type Kysely, sql, type Selectable } from "kysely";
import type { SandboxRecord } from "@decocms/mesh-sdk";
import type { AgentSandboxSessionTable, Database } from "./types";

export type AgentSandboxDesiredState = "running" | "stopped";
export type AgentSandboxSessionStatus =
  | "provisioning"
  | "ready"
  | "missing"
  | "failed"
  | "stopping"
  | "reaping"
  | "deleting"
  | "stopped";

export interface AgentSandboxSessionLocator {
  organizationId: string;
  virtualMcpId: string;
  branch: string;
}

export interface AgentSandboxSession {
  organizationId: string;
  virtualMcpId: string;
  branch: string;
  threadId: string | null;
  sandboxHandle: string | null;
  previewUrl: string | null;
  sandboxApiUrl: string | null;
  desiredState: AgentSandboxDesiredState;
  status: AgentSandboxSessionStatus;
  generation: number;
  startedWith: Record<string, unknown> | null;
  failureReason: string | null;
  createdBy: string;
  lastStartedBy: string;
  createdAt: string;
  updatedAt: string;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toSession(
  row: Selectable<AgentSandboxSessionTable>,
): AgentSandboxSession {
  return {
    organizationId: row.organization_id,
    virtualMcpId: row.virtual_mcp_id,
    branch: row.branch,
    threadId: row.thread_id,
    sandboxHandle: row.sandbox_handle,
    previewUrl: row.preview_url,
    sandboxApiUrl: row.sandbox_api_url,
    desiredState: row.desired_state,
    status: row.status,
    generation: row.generation,
    startedWith: row.started_with,
    failureReason: row.failure_reason,
    createdBy: row.created_by,
    lastStartedBy: row.last_started_by,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export class AgentSandboxSessionStorage {
  constructor(private db: Kysely<Database>) {}

  /**
   * Serialize a short lifecycle state transition for one shared branch.
   *
   * Do not call the runner inside this callback: the runner owns a separate
   * claim lock. Holding both would consume two pool connections per branch and
   * can starve the pool under a multi-branch burst.
   */
  async withLock<T>(
    locator: AgentSandboxSessionLocator,
    fn: (storage: AgentSandboxSessionStorage) => Promise<T>,
  ): Promise<T> {
    const key = sessionLockKey(locator);
    return this.db.transaction().execute(async (transaction) => {
      try {
        await sql`set local statement_timeout = ${sql.lit(SESSION_LOCK_WAIT_MS)}`.execute(
          transaction,
        );
        await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(
          transaction,
        );
      } catch (error) {
        if (isStatementTimeoutError(error)) {
          throw new Error(
            `agent sandbox lifecycle lock busy >${SESSION_LOCK_WAIT_MS}ms for ${locator.virtualMcpId}/${locator.branch}; retry shortly`,
          );
        }
        throw error;
      }
      await sql`set local statement_timeout = 0`.execute(transaction);
      return fn(new AgentSandboxSessionStorage(transaction));
    });
  }

  async find(
    locator: AgentSandboxSessionLocator,
  ): Promise<AgentSandboxSession | null> {
    const row = await this.db
      .selectFrom("agent_sandbox_sessions")
      .selectAll()
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .executeTakeFirst();
    return row ? toSession(row) : null;
  }

  /**
   * Request a running sandbox generation.
   *
   * Concurrent starts join the same generation. A start after stop/missing/
   * failure advances the fence so stale completions cannot overwrite it.
   */
  async beginStart(
    locator: AgentSandboxSessionLocator,
    actorUserId: string,
    threadId: string | null,
  ): Promise<AgentSandboxSession> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("agent_sandbox_sessions")
      .values({
        organization_id: locator.organizationId,
        virtual_mcp_id: locator.virtualMcpId,
        branch: locator.branch,
        thread_id: threadId,
        sandbox_handle: null,
        preview_url: null,
        sandbox_api_url: null,
        desired_state: "running",
        status: "provisioning",
        generation: 1,
        started_with: null,
        failure_reason: null,
        created_by: actorUserId,
        last_started_by: actorUserId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["organization_id", "virtual_mcp_id", "branch"])
          .doNothing(),
      )
      .execute();

    const row = await this.db
      .updateTable("agent_sandbox_sessions")
      .set((expression) => ({
        desired_state: "running",
        generation: sql<number>`case
          when ${expression.ref("desired_state")} = 'stopped'
            or ${expression.ref("status")} in ('missing', 'failed')
          then ${expression.ref("generation")} + 1
          else ${expression.ref("generation")}
        end`,
        status: sql<AgentSandboxSessionStatus>`case
          when ${expression.ref("desired_state")} = 'stopped'
            or ${expression.ref("status")} in ('missing', 'failed')
          then 'provisioning'
          else ${expression.ref("status")}
        end`,
        sandbox_handle: sql<string | null>`case
          when ${expression.ref("desired_state")} = 'stopped'
            or ${expression.ref("status")} in ('missing', 'failed')
          then null
          else ${expression.ref("sandbox_handle")}
        end`,
        preview_url: sql<string | null>`case
          when ${expression.ref("desired_state")} = 'stopped'
            or ${expression.ref("status")} in ('missing', 'failed')
          then null
          else ${expression.ref("preview_url")}
        end`,
        sandbox_api_url: sql<string | null>`case
          when ${expression.ref("desired_state")} = 'stopped'
            or ${expression.ref("status")} in ('missing', 'failed')
          then null
          else ${expression.ref("sandbox_api_url")}
        end`,
        failure_reason: null,
        thread_id: threadId,
        last_started_by: actorUserId,
        updated_at: now,
      }))
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .where("status", "not in", ["stopping", "reaping", "deleting"])
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new Error(
        `agent sandbox lifecycle transition in progress for ${locator.virtualMcpId}/${locator.branch}; retry shortly`,
      );
    }
    return toSession(row);
  }

  async recordProvisioningHandle(
    locator: AgentSandboxSessionLocator,
    generation: number,
    sandboxHandle: string,
  ): Promise<void> {
    await this.db
      .updateTable("agent_sandbox_sessions")
      .set({
        sandbox_handle: sandboxHandle,
        updated_at: new Date().toISOString(),
      })
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .where("generation", "=", generation)
      .where("desired_state", "=", "running")
      .where("status", "=", "provisioning")
      .execute();
  }

  async completeStart(
    locator: AgentSandboxSessionLocator,
    generation: number,
    entry: SandboxRecord,
  ): Promise<AgentSandboxSession | null> {
    const row = await this.db
      .updateTable("agent_sandbox_sessions")
      .set({
        sandbox_handle: entry.sandboxHandle,
        preview_url: entry.previewUrl,
        sandbox_api_url: entry.sandboxApiUrl ?? entry.previewUrl,
        desired_state: "running",
        status: "ready",
        started_with: entry.startedWith
          ? JSON.stringify(entry.startedWith)
          : null,
        failure_reason: null,
        updated_at: new Date().toISOString(),
      })
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .where("generation", "=", generation)
      .where("desired_state", "=", "running")
      .returningAll()
      .executeTakeFirst();
    return row ? toSession(row) : null;
  }

  async failStart(
    locator: AgentSandboxSessionLocator,
    generation: number,
    reason: string,
  ): Promise<void> {
    await this.db
      .updateTable("agent_sandbox_sessions")
      .set({
        status: "failed",
        failure_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .where("generation", "=", generation)
      .where("desired_state", "=", "running")
      .where("status", "=", "provisioning")
      .execute();
  }

  async beginReap(
    locator: AgentSandboxSessionLocator,
    expectedHandle: string,
  ): Promise<AgentSandboxSession | null> {
    const row = await this.db
      .updateTable("agent_sandbox_sessions")
      .set((expression) => ({
        status: "reaping",
        generation: sql<number>`case
          when ${expression.ref("status")} = 'reaping'
          then ${expression.ref("generation")}
          else ${expression.ref("generation")} + 1
        end`,
        updated_at: new Date().toISOString(),
      }))
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .where("sandbox_handle", "=", expectedHandle)
      .where("desired_state", "=", "running")
      .where("status", "not in", ["stopping", "deleting", "stopped"])
      .returningAll()
      .executeTakeFirst();
    return row ? toSession(row) : null;
  }

  async completeReap(
    locator: AgentSandboxSessionLocator,
    generation: number,
    expectedHandle: string,
  ): Promise<void> {
    await this.db
      .updateTable("agent_sandbox_sessions")
      .set({
        status: "missing",
        sandbox_handle: null,
        preview_url: null,
        sandbox_api_url: null,
        updated_at: new Date().toISOString(),
      })
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .where("generation", "=", generation)
      .where("sandbox_handle", "=", expectedHandle)
      .where("desired_state", "=", "running")
      .where("status", "=", "reaping")
      .execute();
  }

  async beginStop(
    locator: AgentSandboxSessionLocator,
    actorUserId: string,
  ): Promise<AgentSandboxSession | null> {
    const row = await this.db
      .updateTable("agent_sandbox_sessions")
      .set((expression) => ({
        desired_state: "stopped",
        status: sql<AgentSandboxSessionStatus>`case
          when ${expression.ref("desired_state")} = 'stopped'
          then ${expression.ref("status")}
          else 'stopping'
        end`,
        generation: sql<number>`case
          when ${expression.ref("desired_state")} = 'stopped'
          then ${expression.ref("generation")}
          else ${expression.ref("generation")} + 1
        end`,
        last_started_by: actorUserId,
        failure_reason: null,
        updated_at: new Date().toISOString(),
      }))
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .returningAll()
      .executeTakeFirst();
    return row ? toSession(row) : null;
  }

  async completeStop(
    locator: AgentSandboxSessionLocator,
    generation: number,
  ): Promise<void> {
    await this.db
      .updateTable("agent_sandbox_sessions")
      .set({
        status: "stopped",
        sandbox_handle: null,
        preview_url: null,
        sandbox_api_url: null,
        updated_at: new Date().toISOString(),
      })
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .where("generation", "=", generation)
      .where("desired_state", "=", "stopped")
      .where("status", "=", "stopping")
      .execute();
  }

  async beginDelete(
    locator: AgentSandboxSessionLocator,
    actorUserId: string,
  ): Promise<AgentSandboxSession | null> {
    const row = await this.db
      .updateTable("agent_sandbox_sessions")
      .set((expression) => ({
        desired_state: "stopped",
        status: "deleting",
        generation: sql<number>`case
          when ${expression.ref("status")} = 'deleting'
          then ${expression.ref("generation")}
          else ${expression.ref("generation")} + 1
        end`,
        last_started_by: actorUserId,
        failure_reason: null,
        updated_at: new Date().toISOString(),
      }))
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .returningAll()
      .executeTakeFirst();
    return row ? toSession(row) : null;
  }

  async completeDelete(
    locator: AgentSandboxSessionLocator,
    generation: number,
  ): Promise<void> {
    await this.db
      .deleteFrom("agent_sandbox_sessions")
      .where("organization_id", "=", locator.organizationId)
      .where("virtual_mcp_id", "=", locator.virtualMcpId)
      .where("branch", "=", locator.branch)
      .where("generation", "=", generation)
      .where("status", "=", "deleting")
      .execute();
  }

  async listByVirtualMcp(
    organizationId: string,
    virtualMcpId: string,
    options: {
      limit?: number;
      before?: { updatedAt: string; branch: string };
    } = {},
  ): Promise<AgentSandboxSession[]> {
    let query = this.db
      .selectFrom("agent_sandbox_sessions")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("virtual_mcp_id", "=", virtualMcpId);
    if (options.before) {
      const beforeDate = new Date(options.before.updatedAt);
      query = query.where((expression) =>
        expression.or([
          expression("updated_at", "<", beforeDate),
          expression.and([
            expression("updated_at", "=", beforeDate),
            expression("branch", "<", options.before!.branch),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy("updated_at", "desc")
      .orderBy("branch", "desc")
      .limit(Math.min(Math.max(options.limit ?? 100, 1), 200))
      .execute();
    return rows.map(toSession);
  }

  async findLatestReadyByVirtualMcp(
    organizationId: string,
    virtualMcpId: string,
  ): Promise<AgentSandboxSession | null> {
    const row = await this.db
      .selectFrom("agent_sandbox_sessions")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("virtual_mcp_id", "=", virtualMcpId)
      .where("desired_state", "=", "running")
      .where("status", "=", "ready")
      .where("sandbox_handle", "is not", null)
      .orderBy("updated_at", "desc")
      .orderBy("branch", "desc")
      .executeTakeFirst();
    return row ? toSession(row) : null;
  }

  async listByThread(
    organizationId: string,
    threadId: string,
  ): Promise<AgentSandboxSession[]> {
    const rows = await this.db
      .selectFrom("agent_sandbox_sessions")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("thread_id", "=", threadId)
      .execute();
    return rows.map(toSession);
  }
}

const SESSION_LOCK_WAIT_MS = 30_000;

function sessionLockKey(locator: AgentSandboxSessionLocator): bigint {
  const hash = createHash("sha256")
    .update(locator.organizationId)
    .update("\x00")
    .update(locator.virtualMcpId)
    .update("\x00")
    .update(locator.branch)
    .digest();
  return hash.readBigInt64BE(0);
}

function isStatementTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "57014" || /statement timeout/i.test(error.message);
}
