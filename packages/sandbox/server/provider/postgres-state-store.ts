import { hash } from "node:crypto";
import postgres from "postgres";
import type {
  RunnerStatePut,
  RunnerStateRecord,
  RunnerStateRecordWithId,
  RunnerStateStore,
  RunnerStateStoreOps,
} from "./state-store";
import type { SandboxId } from "./types";

export interface PostgresRunnerStateStoreOptions {
  url: string;
  maxConnections?: number;
  lockWaitMs?: number;
}

export interface PostgresRunnerStateStore extends RunnerStateStore {
  close(): Promise<void>;
}

type Executor = postgres.ISql;

interface Row {
  user_id: string;
  project_ref: string;
  handle: string;
  state: Record<string, unknown>;
  updated_at: Date;
}

const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_LOCK_WAIT_MS = 90_000;
// Studio's lock key, so a host and Studio sharing a database serialize on the same sandbox.
const SANDBOX_PROVIDER_KIND = "agent-sandbox";

const MIGRATIONS = [
  `create table sandbox_controller.runner_state (
    user_id text not null,
    project_ref text not null,
    handle text not null,
    state jsonb not null,
    updated_at timestamptz not null default now(),
    primary key (user_id, project_ref)
  );
  create index runner_state_handle_idx on sandbox_controller.runner_state (handle);`,
];

function advisoryKey(value: string): string {
  return hash("sha256", value, "buffer").readBigInt64BE(0).toString();
}

function lockKey(id: SandboxId): string {
  return advisoryKey(
    `${id.userId}\x00${id.projectRef}\x00${SANDBOX_PROVIDER_KIND}`,
  );
}

function toRecord(row: Row): RunnerStateRecordWithId {
  return {
    id: { userId: row.user_id, projectRef: row.project_ref },
    handle: row.handle,
    state: row.state,
    updatedAt: row.updated_at,
  };
}

function ops(exec: Executor): RunnerStateStoreOps {
  return {
    async get(id): Promise<RunnerStateRecord | null> {
      const [row] = await exec<Row[]>`
        select handle, state, updated_at from sandbox_controller.runner_state
        where user_id = ${id.userId} and project_ref = ${id.projectRef}`;
      return row
        ? { handle: row.handle, state: row.state, updatedAt: row.updated_at }
        : null;
    },
    async getByHandle(handle) {
      const [row] = await exec<Row[]>`
        select user_id, project_ref, handle, state, updated_at
        from sandbox_controller.runner_state where handle = ${handle} limit 1`;
      return row ? toRecord(row) : null;
    },
    async put(id, entry: RunnerStatePut) {
      const state = JSON.stringify(entry.state);
      const now = new Date().toISOString();
      await exec`
        insert into sandbox_controller.runner_state
          (user_id, project_ref, handle, state, updated_at)
        values (${id.userId}, ${id.projectRef}, ${entry.handle}, ${state}::text::jsonb, ${now})
        on conflict (user_id, project_ref) do update set
          handle = excluded.handle, state = excluded.state, updated_at = excluded.updated_at`;
    },
    async delete(id) {
      await exec`
        delete from sandbox_controller.runner_state
        where user_id = ${id.userId} and project_ref = ${id.projectRef}`;
    },
    async deleteByHandle(handle) {
      await exec`delete from sandbox_controller.runner_state where handle = ${handle}`;
    },
  };
}

/** pg SQLSTATE 57014 = query_canceled, what `statement_timeout` raises. */
function isStatementTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "57014" || /statement timeout/i.test(err.message);
}

/** Applies the store's schema; safe to run on every boot from every replica at once. */
export async function migrateRunnerStateStore({
  url,
}: {
  url: string;
}): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${advisoryKey("sandbox_controller.migrations")}::bigint)`;
      await tx`create schema if not exists sandbox_controller`;
      await tx`
        create table if not exists sandbox_controller.migrations (
          version integer primary key,
          applied_at timestamptz not null default now()
        )`;
      const [{ version }] = await tx<{ version: number }[]>`
        select coalesce(max(version), 0)::int as version from sandbox_controller.migrations`;
      for (const [index, migration] of MIGRATIONS.entries()) {
        if (index < version) continue;
        await tx.unsafe(migration);
        await tx`insert into sandbox_controller.migrations (version) values (${index + 1})`;
      }
    });
  } finally {
    await sql.end();
  }
}

/** `RunnerStateStore` on its own pool, since a lock holder keeps a connection for a whole provisioning. */
export function postgresRunnerStateStore({
  url,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
}: PostgresRunnerStateStoreOptions): PostgresRunnerStateStore {
  const sql = postgres(url, { max: maxConnections, prepare: false });
  return {
    ...ops(sql),
    async withLock<T>(
      id: SandboxId,
      fn: (store: RunnerStateStoreOps) => Promise<T>,
    ): Promise<T> {
      let result!: T;
      await sql.begin(async (tx) => {
        try {
          await tx.unsafe(`set local statement_timeout = ${lockWaitMs}`);
          await tx`select pg_advisory_xact_lock(${lockKey(id)}::bigint)`;
        } catch (err) {
          if (isStatementTimeoutError(err)) {
            throw new Error(
              `sandbox advisory lock busy >${lockWaitMs}ms for user=${id.userId} projectRef=${id.projectRef} — provisioner is slow or stuck; retry shortly`,
            );
          }
          throw err;
        }
        await tx`set local statement_timeout = 0`;
        result = await fn(ops(tx));
      });
      return result;
    },
    close: () => sql.end(),
  };
}
