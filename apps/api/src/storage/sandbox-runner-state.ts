/**
 * Kysely-backed AgentSandbox state store. `state` jsonb is opaque — the
 * AgentSandbox runner serialises its own fields. See
 * packages/@decocms/sandbox/server/provider/.
 *
 * Method implementations take an explicit executor (db or trx) so the scoped
 * store handed to `withLock` callbacks can reuse the lock's connection. If
 * nested reads/writes went through `this.db` instead, each would race the
 * main pool for a separate slot while the lock txn pins one — classic
 * nested-query pool deadlock at `databasePoolMax` concurrent provisionings.
 */

import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type {
  AgentSandboxStatePut,
  AgentSandboxStateRecord,
  AgentSandboxStateRecordWithId,
  AgentSandboxStateStore,
  AgentSandboxStateStoreOps,
} from "@decocms/sandbox/provider/agent-sandbox";
import type { SandboxId } from "@decocms/sandbox/provider";
import type { Database } from "./types";

type Executor = Kysely<Database>;
const AGENT_SANDBOX_KIND = "agent-sandbox" as const;

/**
 * Hash `(userId, projectRef, "agent-sandbox")` to a signed int64 for
 * `pg_advisory_xact_lock` — cast so the range fits pg's `bigint`. Keeping the
 * canonical kind in the hash preserves lock compatibility with older Studio
 * pods during a rolling deployment.
 */
function lockKey(id: SandboxId): bigint {
  const h = createHash("sha256")
    .update(id.userId)
    .update("\x00")
    .update(id.projectRef)
    .update("\x00")
    .update(AGENT_SANDBOX_KIND)
    .digest();
  return h.readBigInt64BE(0);
}

async function getRow(
  exec: Executor,
  id: SandboxId,
): Promise<AgentSandboxStateRecord | null> {
  const row = await exec
    .selectFrom("sandbox_runner_state")
    .select(["handle", "state", "updated_at"])
    .where("user_id", "=", id.userId)
    .where("project_ref", "=", id.projectRef)
    .where("sandbox_provider_kind", "=", AGENT_SANDBOX_KIND)
    .executeTakeFirst();
  if (!row) return null;
  return {
    handle: row.handle,
    state: row.state as Record<string, unknown>,
    updatedAt: row.updated_at as Date,
  };
}

async function getByHandleRow(
  exec: Executor,
  handle: string,
): Promise<AgentSandboxStateRecordWithId | null> {
  const row = await exec
    .selectFrom("sandbox_runner_state")
    .select(["user_id", "project_ref", "handle", "state", "updated_at"])
    .where("sandbox_provider_kind", "=", AGENT_SANDBOX_KIND)
    .where("handle", "=", handle)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: { userId: row.user_id, projectRef: row.project_ref },
    handle: row.handle,
    state: row.state as Record<string, unknown>,
    updatedAt: row.updated_at as Date,
  };
}

async function putRow(
  exec: Executor,
  id: SandboxId,
  entry: AgentSandboxStatePut,
): Promise<void> {
  const stateJson = JSON.stringify(entry.state);
  const now = new Date().toISOString();
  await exec
    .insertInto("sandbox_runner_state")
    .values({
      user_id: id.userId,
      project_ref: id.projectRef,
      sandbox_provider_kind: AGENT_SANDBOX_KIND,
      handle: entry.handle,
      state: stateJson,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc
        .columns(["user_id", "project_ref", "sandbox_provider_kind"])
        .doUpdateSet({
          handle: entry.handle,
          state: stateJson,
          updated_at: now,
        }),
    )
    .execute();
}

async function deleteRow(exec: Executor, id: SandboxId): Promise<void> {
  await exec
    .deleteFrom("sandbox_runner_state")
    .where("user_id", "=", id.userId)
    .where("project_ref", "=", id.projectRef)
    .where("sandbox_provider_kind", "=", AGENT_SANDBOX_KIND)
    .execute();
}

async function deleteByHandleRow(
  exec: Executor,
  handle: string,
): Promise<void> {
  await exec
    .deleteFrom("sandbox_runner_state")
    .where("sandbox_provider_kind", "=", AGENT_SANDBOX_KIND)
    .where("handle", "=", handle)
    .execute();
}

function scopedStore(exec: Executor): AgentSandboxStateStoreOps {
  return {
    get: (id) => getRow(exec, id),
    getByHandle: (handle) => getByHandleRow(exec, handle),
    put: (id, entry) => putRow(exec, id, entry),
    delete: (id) => deleteRow(exec, id),
    deleteByHandle: (handle) => deleteByHandleRow(exec, handle),
  };
}

export class KyselyAgentSandboxStateStore implements AgentSandboxStateStore {
  constructor(private db: Kysely<Database>) {}

  get(id: SandboxId): Promise<AgentSandboxStateRecord | null> {
    return getRow(this.db, id);
  }

  getByHandle(handle: string): Promise<AgentSandboxStateRecordWithId | null> {
    return getByHandleRow(this.db, handle);
  }

  put(id: SandboxId, entry: AgentSandboxStatePut): Promise<void> {
    return putRow(this.db, id, entry);
  }

  delete(id: SandboxId): Promise<void> {
    return deleteRow(this.db, id);
  }

  deleteByHandle(handle: string): Promise<void> {
    return deleteByHandleRow(this.db, handle);
  }

  /**
   * Serialize ensure() across pods. pg_advisory_xact_lock is transactional
   * — released on COMMIT / ROLLBACK / connection drop, so a crashed pod
   * never strands a sandbox. The callback receives a scoped ops view whose
   * methods reuse the transaction's connection; using it instead of the
   * outer store is what keeps the main pool free during long provisioning.
   *
   * The lock wait is bounded via `SET LOCAL statement_timeout`: the holder
   * runs slow provisioning inside its lock, and an unbounded wait lets one
   * stalled holder wedge every concurrent ensure (observed: 132s). Timeout
   * clears before the callback runs so nested reads/writes aren't capped by
   * the lock-wait budget.
   */
  async withLock<T>(
    id: SandboxId,
    fn: (store: AgentSandboxStateStoreOps) => Promise<T>,
  ): Promise<T> {
    const key = lockKey(id);
    return this.db.transaction().execute(async (trx) => {
      try {
        await sql`set local statement_timeout = ${sql.lit(LOCK_WAIT_MS)}`.execute(
          trx,
        );
        await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(trx);
      } catch (err) {
        if (isStatementTimeoutError(err)) {
          throw new Error(
            `agent-sandbox advisory lock busy >${LOCK_WAIT_MS}ms for user=${id.userId} projectRef=${id.projectRef} — provisioner is slow or stuck; retry shortly`,
          );
        }
        throw err;
      }
      await sql`set local statement_timeout = 0`.execute(trx);
      return fn(scopedStore(trx));
    });
  }
}

/** Generous enough to cover agent-sandbox waitForSandboxReady (180s) + buffer; short enough that a stuck holder isn't invisible. */
const LOCK_WAIT_MS = 90_000;

/** pg SQLSTATE 57014 = query_canceled — what `statement_timeout` raises. */
function isStatementTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "57014" || /statement timeout/i.test(err.message);
}
