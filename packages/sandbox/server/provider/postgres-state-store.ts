import { hash } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import {
  tenantPoolSchema,
  type TenantPool,
} from "./agent-sandbox/tenant-pools";
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
  `create table sandbox_controller.tenant_pools (
    id uuid primary key default gen_random_uuid(),
    cluster text not null,
    name text not null,
    org_id text not null,
    repo text not null,
    branch text not null default 'main',
    connection_id text,
    workload jsonb not null,
    size integer not null check (size >= 1),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (cluster, name)
  );`,
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

/** Applies the `sandbox_controller` schema; safe to run on every boot from every replica at once. */
export async function migrateSandboxControllerSchema({
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

export const storedTenantPoolInputSchema = tenantPoolSchema.extend({
  size: z.number().int().min(1),
});

export type StoredTenantPoolInput = z.input<typeof storedTenantPoolInputSchema>;

export type StoredTenantPool = TenantPool & { cluster: string; size: number };

export interface PostgresTenantPoolStoreOptions {
  url: string;
  maxConnections?: number;
}

export interface TenantPoolStore {
  list(cluster: string): Promise<StoredTenantPool[]>;
  upsert(
    cluster: string,
    input: StoredTenantPoolInput,
  ): Promise<{ pool: StoredTenantPool; created: boolean }>;
  delete(cluster: string, name: string): Promise<boolean>;
}

export interface PostgresTenantPoolStore extends TenantPoolStore {
  close(): Promise<void>;
}

/** A pool name already taken in the cluster by another org or repo: its warm pods hold that tenant's checkout. */
export class TenantPoolConflictError extends Error {
  constructor(
    readonly cluster: string,
    readonly poolName: string,
  ) {
    super(
      `pool ${poolName} already exists in ${cluster} for another org or repo`,
    );
    this.name = "TenantPoolConflictError";
  }
}

interface PoolRow {
  cluster: string;
  name: string;
  org_id: string;
  repo: string;
  branch: string;
  connection_id: string | null;
  workload: unknown;
  size: number;
}

function toStoredPool(row: PoolRow): StoredTenantPool {
  return {
    cluster: row.cluster,
    name: row.name,
    orgId: row.org_id,
    repo: row.repo,
    branch: row.branch,
    workload: tenantPoolSchema.shape.workload.parse(row.workload),
    ...(row.connection_id ? { connectionId: row.connection_id } : {}),
    size: row.size,
  };
}

const DEFAULT_POOL_STORE_MAX_CONNECTIONS = 2;

export function postgresTenantPoolStore({
  url,
  maxConnections = DEFAULT_POOL_STORE_MAX_CONNECTIONS,
}: PostgresTenantPoolStoreOptions): PostgresTenantPoolStore {
  const sql = postgres(url, { max: maxConnections, prepare: false });
  return {
    async list(cluster) {
      const rows = await sql<PoolRow[]>`
        select cluster, name, org_id, repo, branch, connection_id, workload, size
        from sandbox_controller.tenant_pools
        where cluster = ${cluster} order by name`;
      return rows.map(toStoredPool);
    },
    async upsert(cluster, raw) {
      const input = storedTenantPoolInputSchema.parse(raw);
      const workload = JSON.stringify(input.workload);
      const [row] = await sql<(PoolRow & { created: boolean })[]>`
        insert into sandbox_controller.tenant_pools
          (cluster, name, org_id, repo, branch, connection_id, workload, size)
        values (${cluster}, ${input.name}, ${input.orgId}, ${input.repo}, ${input.branch},
          ${input.connectionId ?? null}, ${workload}::text::jsonb, ${input.size})
        on conflict (cluster, name) do update set
          repo = excluded.repo, branch = excluded.branch,
          connection_id = excluded.connection_id, workload = excluded.workload,
          size = excluded.size, updated_at = now()
        where tenant_pools.org_id = excluded.org_id
          and lower(tenant_pools.repo) = lower(excluded.repo)
        returning cluster, name, org_id, repo, branch, connection_id, workload, size,
          (xmax = 0) as created`;
      if (!row) throw new TenantPoolConflictError(cluster, input.name);
      const { created, ...pool } = row;
      return { pool: toStoredPool(pool), created };
    },
    async delete(cluster, name) {
      const rows = await sql`
        delete from sandbox_controller.tenant_pools
        where cluster = ${cluster} and name = ${name} returning id`;
      return rows.length > 0;
    },
    close: () => sql.end(),
  };
}

export interface TenantPoolReaderOptions {
  refreshMs?: number;
}

export interface TenantPoolReader {
  start(): Promise<readonly TenantPool[]>;
  stop(): void;
  refresh(): Promise<readonly TenantPool[]>;
  current(): readonly TenantPool[];
}

const DEFAULT_TENANT_POOL_REFRESH_MS = 30_000;

/** A cached pool list for `AgentSandboxProvider`'s `tenantPools`; a failed load keeps the last one. */
export function tenantPoolReader(
  store: Pick<TenantPoolStore, "list">,
  cluster: string,
  { refreshMs = DEFAULT_TENANT_POOL_REFRESH_MS }: TenantPoolReaderOptions = {},
): TenantPoolReader {
  let pools: readonly TenantPool[] = [];
  let latestLoad = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<readonly TenantPool[]> {
    const load = ++latestLoad;
    try {
      const rows = await store.list(cluster);
      if (load === latestLoad) {
        pools = rows.map(({ cluster: _cluster, size: _size, ...pool }) => pool);
      }
    } catch (err) {
      console.warn(
        `[sandbox] tenant pool refresh for ${cluster} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return pools;
  }

  return {
    start() {
      timer ??= setInterval(() => void refresh(), refreshMs);
      return refresh();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    refresh,
    current: () => pools,
  };
}
