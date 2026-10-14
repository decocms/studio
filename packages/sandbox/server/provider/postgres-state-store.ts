import { hash } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import {
  allocatedReplicas,
  duplicateRepoAllocation,
  TenantPoolCapacityError,
  tenantPoolFieldsSchema,
  type TenantPool,
  type TenantPoolFieldsInput,
  type TenantPoolRepoInput,
  tenantPoolRepoSchema,
  tenantPoolWorkloadSchema,
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
  /** Keeps one host's rows apart from another's sharing the database, e.g. one per Studio env. Default `""`. */
  scope?: string;
  maxConnections?: number;
  lockWaitMs?: number;
}

export interface PostgresRunnerStateStore extends RunnerStateStore {
  /** This scope's rows, most recently updated first; `state` holds daemon bearers, so never expose it as is. */
  list(opts?: { limit?: number }): Promise<RunnerStateRecordWithId[]>;
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
    tenant text not null,
    size integer not null check (size >= 1),
    image text not null default 'default',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (cluster, name)
  );
  create table sandbox_controller.tenant_pool_repos (
    pool_id uuid not null references sandbox_controller.tenant_pools (id) on delete cascade,
    repo_url text not null,
    branch text not null,
    workload jsonb not null,
    replicas integer not null check (replicas >= 1),
    unique (pool_id, repo_url, branch)
  );`,
  `alter table sandbox_controller.runner_state add column scope text not null default '';
  alter table sandbox_controller.runner_state drop constraint runner_state_pkey;
  alter table sandbox_controller.runner_state add primary key (scope, user_id, project_ref);
  drop index sandbox_controller.runner_state_handle_idx;
  create index runner_state_handle_idx on sandbox_controller.runner_state (scope, handle);`,
];

function advisoryKey(value: string): string {
  return hash("sha256", value, "buffer").readBigInt64BE(0).toString();
}

function lockKey(id: SandboxId, scope: string): string {
  const key = `${id.userId}\x00${id.projectRef}\x00${SANDBOX_PROVIDER_KIND}`;
  return advisoryKey(scope ? `${key}\x00${scope}` : key);
}

function toRecord(row: Row): RunnerStateRecordWithId {
  return {
    id: { userId: row.user_id, projectRef: row.project_ref },
    handle: row.handle,
    state: row.state,
    updatedAt: row.updated_at,
  };
}

function ops(exec: Executor, scope: string): RunnerStateStoreOps {
  return {
    async get(id): Promise<RunnerStateRecord | null> {
      const [row] = await exec<Row[]>`
        select handle, state, updated_at from sandbox_controller.runner_state
        where scope = ${scope} and user_id = ${id.userId} and project_ref = ${id.projectRef}`;
      return row
        ? { handle: row.handle, state: row.state, updatedAt: row.updated_at }
        : null;
    },
    async getByHandle(handle) {
      const [row] = await exec<Row[]>`
        select user_id, project_ref, handle, state, updated_at
        from sandbox_controller.runner_state
        where scope = ${scope} and handle = ${handle} limit 1`;
      return row ? toRecord(row) : null;
    },
    async put(id, entry: RunnerStatePut) {
      const state = JSON.stringify(entry.state);
      const now = new Date().toISOString();
      await exec`
        insert into sandbox_controller.runner_state
          (scope, user_id, project_ref, handle, state, updated_at)
        values (${scope}, ${id.userId}, ${id.projectRef}, ${entry.handle}, ${state}::text::jsonb, ${now})
        on conflict (scope, user_id, project_ref) do update set
          handle = excluded.handle, state = excluded.state, updated_at = excluded.updated_at`;
    },
    async delete(id) {
      await exec`
        delete from sandbox_controller.runner_state
        where scope = ${scope} and user_id = ${id.userId} and project_ref = ${id.projectRef}`;
    },
    async deleteByHandle(handle) {
      await exec`
        delete from sandbox_controller.runner_state
        where scope = ${scope} and handle = ${handle}`;
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
  scope = "",
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
}: PostgresRunnerStateStoreOptions): PostgresRunnerStateStore {
  const sql = postgres(url, { max: maxConnections, prepare: false });
  return {
    ...ops(sql, scope),
    async list({ limit = 500 } = {}) {
      const rows = await sql<Row[]>`
        select user_id, project_ref, handle, state, updated_at
        from sandbox_controller.runner_state
        where scope = ${scope} order by updated_at desc limit ${limit}`;
      return rows.map(toRecord);
    },
    async withLock<T>(
      id: SandboxId,
      fn: (store: RunnerStateStoreOps) => Promise<T>,
    ): Promise<T> {
      let result!: T;
      await sql.begin(async (tx) => {
        try {
          await tx.unsafe(`set local statement_timeout = ${lockWaitMs}`);
          await tx`select pg_advisory_xact_lock(${lockKey(id, scope)}::bigint)`;
        } catch (err) {
          if (isStatementTimeoutError(err)) {
            throw new Error(
              `sandbox advisory lock busy >${lockWaitMs}ms for user=${id.userId} projectRef=${id.projectRef} — provisioner is slow or stuck; retry shortly`,
            );
          }
          throw err;
        }
        await tx`set local statement_timeout = 0`;
        result = await fn(ops(tx, scope));
      });
      return result;
    },
    close: () => sql.end(),
  };
}

export type StoredTenantPool = TenantPool & { cluster: string };

export interface PostgresTenantPoolStoreOptions {
  url: string;
  maxConnections?: number;
}

export interface TenantPoolStore {
  list(cluster: string): Promise<StoredTenantPool[]>;
  /** Creates or updates the pool's own fields; its repos are left as they are. */
  upsertPool(
    cluster: string,
    input: TenantPoolFieldsInput,
  ): Promise<{ pool: StoredTenantPool; created: boolean }>;
  deletePool(cluster: string, name: string): Promise<boolean>;
  /** Replaces the pool's repo allocations; null when there is no such pool. */
  setRepos(
    cluster: string,
    name: string,
    repos: readonly TenantPoolRepoInput[],
  ): Promise<StoredTenantPool | null>;
}

export interface PostgresTenantPoolStore extends TenantPoolStore {
  close(): Promise<void>;
}

/** A pool name already taken in the cluster by another tenant: its warm pods hold that tenant's checkouts. */
export class TenantPoolConflictError extends Error {
  constructor(
    readonly cluster: string,
    readonly poolName: string,
  ) {
    super(`pool ${poolName} already exists in ${cluster} for another tenant`);
    this.name = "TenantPoolConflictError";
  }
}

interface PoolRow {
  cluster: string;
  name: string;
  tenant: string;
  size: number;
  image: string;
  repos: {
    repoUrl: string;
    branch: string;
    workload: unknown;
    replicas: number;
  }[];
}

function toStoredPool(row: PoolRow): StoredTenantPool {
  return {
    cluster: row.cluster,
    name: row.name,
    tenant: row.tenant,
    size: row.size,
    image: row.image,
    repos: row.repos.map((repo) => ({
      repoUrl: repo.repoUrl,
      branch: repo.branch,
      workload: tenantPoolWorkloadSchema.parse(repo.workload),
      replicas: repo.replicas,
    })),
  };
}

const DEFAULT_POOL_STORE_MAX_CONNECTIONS = 2;

function selectPools(exec: Executor, cluster: string, name?: string) {
  return exec<PoolRow[]>`
    select p.cluster, p.name, p.tenant, p.size, p.image,
      coalesce(
        json_agg(json_build_object(
          'repoUrl', r.repo_url, 'branch', r.branch,
          'workload', r.workload, 'replicas', r.replicas
        ) order by r.repo_url, r.branch) filter (where r.pool_id is not null),
        '[]'
      ) as repos
    from sandbox_controller.tenant_pools p
    left join sandbox_controller.tenant_pool_repos r on r.pool_id = p.id
    where p.cluster = ${cluster} ${name === undefined ? exec`` : exec`and p.name = ${name}`}
    group by p.id order by p.name`;
}

async function storedAllocatedReplicas(exec: Executor, poolId: string) {
  const [{ allocated }] = await exec<{ allocated: number }[]>`
    select coalesce(sum(replicas), 0)::int as allocated
    from sandbox_controller.tenant_pool_repos where pool_id = ${poolId}`;
  return allocated;
}

export function postgresTenantPoolStore({
  url,
  maxConnections = DEFAULT_POOL_STORE_MAX_CONNECTIONS,
}: PostgresTenantPoolStoreOptions): PostgresTenantPoolStore {
  const sql = postgres(url, { max: maxConnections, prepare: false });

  async function readPool(exec: Executor, cluster: string, name: string) {
    const [row] = await selectPools(exec, cluster, name);
    if (!row) throw new Error(`pool ${name} vanished inside its transaction`);
    return toStoredPool(row);
  }

  return {
    async list(cluster) {
      return (await selectPools(sql, cluster)).map(toStoredPool);
    },
    async upsertPool(cluster, raw) {
      const input = tenantPoolFieldsSchema.parse(raw);
      let created = false;
      const pool = await sql.begin(async (tx) => {
        const inserted = await tx`
          insert into sandbox_controller.tenant_pools (cluster, name, tenant, size, image)
          values (${cluster}, ${input.name}, ${input.tenant}, ${input.size}, ${input.image})
          on conflict (cluster, name) do nothing
          returning id`;
        if (inserted.length > 0) {
          created = true;
          return readPool(tx, cluster, input.name);
        }
        const [held] = await tx<{ id: string; tenant: string }[]>`
          select id, tenant from sandbox_controller.tenant_pools
          where cluster = ${cluster} and name = ${input.name} for update`;
        if (!held) throw new Error(`pool ${input.name} vanished mid-upsert`);
        if (held.tenant !== input.tenant) {
          throw new TenantPoolConflictError(cluster, input.name);
        }
        const allocated = await storedAllocatedReplicas(tx, held.id);
        if (allocated > input.size) {
          throw new TenantPoolCapacityError(input.name, input.size, allocated);
        }
        await tx`
          update sandbox_controller.tenant_pools
          set size = ${input.size}, image = ${input.image}, updated_at = now()
          where id = ${held.id}`;
        return readPool(tx, cluster, input.name);
      });
      return { pool, created };
    },
    async deletePool(cluster, name) {
      const rows = await sql`
        delete from sandbox_controller.tenant_pools
        where cluster = ${cluster} and name = ${name} returning id`;
      return rows.length > 0;
    },
    async setRepos(cluster, name, raw) {
      const repos = z.array(tenantPoolRepoSchema).parse(raw);
      const duplicate = duplicateRepoAllocation(repos);
      if (duplicate) {
        throw new Error(
          `pool ${name}: duplicate repo allocation ${duplicate.repoUrl}#${duplicate.branch}`,
        );
      }
      return sql.begin(async (tx) => {
        const [held] = await tx<{ id: string; size: number }[]>`
          select id, size from sandbox_controller.tenant_pools
          where cluster = ${cluster} and name = ${name} for update`;
        if (!held) return null;
        const allocated = allocatedReplicas(repos);
        if (allocated > held.size) {
          throw new TenantPoolCapacityError(name, held.size, allocated);
        }
        await tx`delete from sandbox_controller.tenant_pool_repos where pool_id = ${held.id}`;
        for (const repo of repos) {
          const workload = JSON.stringify(repo.workload);
          await tx`
            insert into sandbox_controller.tenant_pool_repos
              (pool_id, repo_url, branch, workload, replicas)
            values (${held.id}, ${repo.repoUrl}, ${repo.branch}, ${workload}::text::jsonb, ${repo.replicas})`;
        }
        await tx`
          update sandbox_controller.tenant_pools set updated_at = now()
          where id = ${held.id}`;
        return readPool(tx, cluster, name);
      });
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
        pools = rows.map(({ cluster: _cluster, ...pool }) => pool);
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
