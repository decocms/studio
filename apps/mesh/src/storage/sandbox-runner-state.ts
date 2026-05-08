/**
 * Kysely-backed RunnerStateStore. `state` jsonb is opaque — each runner
 * serialises its own fields. See
 * packages/@decocms/sandbox/server/runner/.
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
  RunnerStatePut,
  RunnerStateRecord,
  RunnerStateRecordWithId,
  RunnerStateStore,
  RunnerStateStoreOps,
  SandboxId,
} from "@decocms/sandbox/runner";
import type { Database } from "./types";

type Executor = Kysely<Database>;

/**
 * Hash `(userId, projectRef, kind)` to a signed int64 for
 * `pg_advisory_xact_lock` — cast so the range fits pg's `bigint`.
 */
function lockKey(id: SandboxId, kind: string): bigint {
  const h = createHash("sha256")
    .update(id.userId)
    .update("\x00")
    .update(id.projectRef)
    .update("\x00")
    .update(kind)
    .digest();
  return h.readBigInt64BE(0);
}

async function getRow(
  exec: Executor,
  id: SandboxId,
  kind: string,
): Promise<RunnerStateRecord | null> {
  const row = await exec
    .selectFrom("sandbox_runner_state")
    .select(["handle", "state", "updated_at"])
    .where("user_id", "=", id.userId)
    .where("project_ref", "=", id.projectRef)
    .where("runner_kind", "=", kind)
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
  kind: string,
  handle: string,
): Promise<RunnerStateRecordWithId | null> {
  const row = await exec
    .selectFrom("sandbox_runner_state")
    .select(["user_id", "project_ref", "handle", "state", "updated_at"])
    .where("runner_kind", "=", kind)
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
  kind: string,
  entry: RunnerStatePut,
): Promise<void> {
  const stateJson = JSON.stringify(entry.state);
  const now = new Date().toISOString();
  await exec
    .insertInto("sandbox_runner_state")
    .values({
      user_id: id.userId,
      project_ref: id.projectRef,
      runner_kind: kind,
      handle: entry.handle,
      state: stateJson,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "project_ref", "runner_kind"]).doUpdateSet({
        handle: entry.handle,
        state: stateJson,
        updated_at: now,
      }),
    )
    .execute();
}

async function deleteRow(
  exec: Executor,
  id: SandboxId,
  kind: string,
): Promise<void> {
  await exec
    .deleteFrom("sandbox_runner_state")
    .where("user_id", "=", id.userId)
    .where("project_ref", "=", id.projectRef)
    .where("runner_kind", "=", kind)
    .execute();
}

async function deleteByHandleRow(
  exec: Executor,
  kind: string,
  handle: string,
): Promise<void> {
  await exec
    .deleteFrom("sandbox_runner_state")
    .where("runner_kind", "=", kind)
    .where("handle", "=", handle)
    .execute();
}

function scopedStore(exec: Executor): RunnerStateStoreOps {
  return {
    get: (id, kind) => getRow(exec, id, kind),
    getByHandle: (kind, handle) => getByHandleRow(exec, kind, handle),
    put: (id, kind, entry) => putRow(exec, id, kind, entry),
    delete: (id, kind) => deleteRow(exec, id, kind),
    deleteByHandle: (kind, handle) => deleteByHandleRow(exec, kind, handle),
  };
}

export class KyselySandboxRunnerStateStore implements RunnerStateStore {
  constructor(private db: Kysely<Database>) {}

  get(id: SandboxId, kind: string): Promise<RunnerStateRecord | null> {
    return getRow(this.db, id, kind);
  }

  getByHandle(
    kind: string,
    handle: string,
  ): Promise<RunnerStateRecordWithId | null> {
    return getByHandleRow(this.db, kind, handle);
  }

  put(id: SandboxId, kind: string, entry: RunnerStatePut): Promise<void> {
    return putRow(this.db, id, kind, entry);
  }

  delete(id: SandboxId, kind: string): Promise<void> {
    return deleteRow(this.db, id, kind);
  }

  deleteByHandle(kind: string, handle: string): Promise<void> {
    return deleteByHandleRow(this.db, kind, handle);
  }

  /**
   * Serialize ensure() across pods. pg_advisory_xact_lock is transactional
   * — released on COMMIT / ROLLBACK / connection drop, so a crashed pod
   * never strands a sandbox. The callback receives a scoped ops view whose
   * methods reuse the transaction's connection; using it instead of the
   * outer store is what keeps the main pool free during long provisioning.
   *
   * The lock wait is bounded via `SET LOCAL statement_timeout`: the holder
   * runs slow provisioning (freestyle.vms.create ≈ 30–60s) inside its lock,
   * and an unbounded wait lets one stalled holder wedge every concurrent
   * ensure (observed: 132s). Timeout clears before the callback runs so
   * nested reads/writes aren't capped by the lock-wait budget.
   */
  async withLock<T>(
    id: SandboxId,
    kind: string,
    fn: (store: RunnerStateStoreOps) => Promise<T>,
  ): Promise<T> {
    const key = lockKey(id, kind);
    return this.db.transaction().execute(async (trx) => {
      try {
        await sql`set local statement_timeout = ${sql.lit(LOCK_WAIT_MS)}`.execute(
          trx,
        );
        await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(trx);
      } catch (err) {
        if (isStatementTimeoutError(err)) {
          throw new Error(
            `sandbox advisory lock busy >${LOCK_WAIT_MS}ms for user=${id.userId} projectRef=${id.projectRef} kind=${kind} — provisioner is slow or stuck; retry shortly`,
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
