/**
 * Kysely-backed runner state for shared agent-sandbox claims.
 *
 * Unlike sandbox-runner-state.ts, this store deliberately has no user column:
 * projectRef already encodes organization, virtual MCP, and branch.
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
} from "@decocms/sandbox/provider";
import type { Database } from "./types";

type Executor = Kysely<Database>;

function requireSharedId(
  id: SandboxId,
): Extract<SandboxId, { scope: "shared" }> {
  if (id.scope !== "shared") {
    throw new Error(
      "KyselyAgentSandboxRunnerStateStore only accepts shared sandbox ids",
    );
  }
  return id;
}

function lockKey(id: SandboxId, kind: string): bigint {
  const shared = requireSharedId(id);
  const hash = createHash("sha256")
    .update(shared.projectRef)
    .update("\x00")
    .update(kind)
    .digest();
  return hash.readBigInt64BE(0);
}

async function getRow(
  exec: Executor,
  id: SandboxId,
  kind: string,
): Promise<RunnerStateRecord | null> {
  const shared = requireSharedId(id);
  const row = await exec
    .selectFrom("agent_sandbox_runner_state")
    .select(["handle", "state", "updated_at"])
    .where("project_ref", "=", shared.projectRef)
    .where("sandbox_provider_kind", "=", kind)
    .executeTakeFirst();
  if (!row) return null;
  return {
    handle: row.handle,
    state: row.state,
    updatedAt: row.updated_at,
  };
}

async function getByHandleRow(
  exec: Executor,
  kind: string,
  handle: string,
): Promise<RunnerStateRecordWithId | null> {
  const row = await exec
    .selectFrom("agent_sandbox_runner_state")
    .select(["project_ref", "handle", "state", "updated_at"])
    .where("sandbox_provider_kind", "=", kind)
    .where("handle", "=", handle)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: { scope: "shared", projectRef: row.project_ref },
    handle: row.handle,
    state: row.state,
    updatedAt: row.updated_at,
  };
}

async function putRow(
  exec: Executor,
  id: SandboxId,
  kind: string,
  entry: RunnerStatePut,
): Promise<void> {
  const shared = requireSharedId(id);
  const stateJson = JSON.stringify(entry.state);
  const now = new Date().toISOString();
  await exec
    .insertInto("agent_sandbox_runner_state")
    .values({
      project_ref: shared.projectRef,
      sandbox_provider_kind: kind,
      handle: entry.handle,
      state: stateJson,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict.columns(["project_ref", "sandbox_provider_kind"]).doUpdateSet({
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
  const shared = requireSharedId(id);
  await exec
    .deleteFrom("agent_sandbox_runner_state")
    .where("project_ref", "=", shared.projectRef)
    .where("sandbox_provider_kind", "=", kind)
    .execute();
}

async function deleteByHandleRow(
  exec: Executor,
  kind: string,
  handle: string,
): Promise<void> {
  await exec
    .deleteFrom("agent_sandbox_runner_state")
    .where("sandbox_provider_kind", "=", kind)
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

export class KyselyAgentSandboxRunnerStateStore implements RunnerStateStore {
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

  async withLock<T>(
    id: SandboxId,
    kind: string,
    fn: (store: RunnerStateStoreOps) => Promise<T>,
  ): Promise<T> {
    const shared = requireSharedId(id);
    const key = lockKey(id, kind);
    return this.db.transaction().execute(async (transaction) => {
      try {
        await sql`set local statement_timeout = ${sql.lit(LOCK_WAIT_MS)}`.execute(
          transaction,
        );
        await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(
          transaction,
        );
      } catch (error) {
        if (isStatementTimeoutError(error)) {
          throw new Error(
            `agent sandbox advisory lock busy >${LOCK_WAIT_MS}ms for projectRef=${shared.projectRef} kind=${kind} — provisioner is slow or stuck; retry shortly`,
          );
        }
        throw error;
      }
      await sql`set local statement_timeout = 0`.execute(transaction);
      return fn(scopedStore(transaction));
    });
  }
}

const LOCK_WAIT_MS = 90_000;

function isStatementTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "57014" || /statement timeout/i.test(error.message);
}
