import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { TenantPoolCapacityError } from "./agent-sandbox/tenant-pools";
import {
  migrateSandboxControllerSchema,
  postgresRunnerStateStore,
  postgresTenantPoolStore,
  TenantPoolConflictError,
  tenantPoolReader,
  type PostgresRunnerStateStore,
  type PostgresTenantPoolStore,
} from "./postgres-state-store";
import type { SandboxId } from "./types";

const adminUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";
const database = `sbx_store_test_${randomUUID().replaceAll("-", "")}`;
const url = Object.assign(new URL(adminUrl), { pathname: `/${database}` }).href;

const admin = postgres(adminUrl, { max: 1 });
let store: PostgresRunnerStateStore;
let pools: PostgresTenantPoolStore;

function sandboxId(): SandboxId {
  return { userId: `user_${randomUUID()}`, projectRef: `ref_${randomUUID()}` };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  await admin.unsafe(`create database ${database}`);
  store = postgresRunnerStateStore({ url });
  pools = postgresTenantPoolStore({ url });
});

afterAll(async () => {
  await store.close();
  await pools.close();
  await admin.unsafe(`drop database if exists ${database} with (force)`);
  await admin.end();
});

describe("migrateSandboxControllerSchema", () => {
  it("runs concurrently and again without reapplying a version", async () => {
    await Promise.all([
      migrateSandboxControllerSchema({ url }),
      migrateSandboxControllerSchema({ url }),
      migrateSandboxControllerSchema({ url }),
    ]);
    await migrateSandboxControllerSchema({ url });

    const sql = postgres(url, { max: 1 });
    try {
      const versions = await sql`
        select version from sandbox_controller.migrations order by version`;
      expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
      const [tables] = await sql`
        select to_regclass('sandbox_controller.runner_state') as runner_state,
          to_regclass('sandbox_controller.tenant_pools') as tenant_pools,
          to_regclass('sandbox_controller.tenant_pool_repos') as tenant_pool_repos`;
      expect(tables?.runner_state).toBe("sandbox_controller.runner_state");
      expect(tables?.tenant_pools).toBe("sandbox_controller.tenant_pools");
      expect(tables?.tenant_pool_repos).toBe(
        "sandbox_controller.tenant_pool_repos",
      );
    } finally {
      await sql.end();
    }
  });

  it("upgrades a v1-only database concurrently, keeping its runner state in the default scope", async () => {
    await migrateSandboxControllerSchema({ url });
    const sql = postgres(url, { max: 1 });
    const id = sandboxId();
    try {
      await sql`drop table sandbox_controller.tenant_pool_repos, sandbox_controller.tenant_pools`;
      await sql.unsafe(`
        alter table sandbox_controller.runner_state drop constraint runner_state_pkey;
        drop index sandbox_controller.runner_state_handle_idx;
        alter table sandbox_controller.runner_state drop column scope;
        alter table sandbox_controller.runner_state add primary key (user_id, project_ref);
        create index runner_state_handle_idx on sandbox_controller.runner_state (handle);`);
      await sql`delete from sandbox_controller.migrations where version > 1`;
      await sql`
        insert into sandbox_controller.runner_state (user_id, project_ref, handle, state)
        values (${id.userId}, ${id.projectRef}, 'h_v1', ${sql.json({ kept: true })})`;

      await Promise.all([
        migrateSandboxControllerSchema({ url }),
        migrateSandboxControllerSchema({ url }),
        migrateSandboxControllerSchema({ url }),
      ]);
      await migrateSandboxControllerSchema({ url });

      const versions = await sql`
        select version from sandbox_controller.migrations order by version`;
      expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
      expect((await store.get(id))?.state).toEqual({ kept: true });
      expect(await pools.list(`c_${randomUUID()}`)).toEqual([]);
    } finally {
      await store.delete(id);
      await sql.end();
    }
  });
});

describe("postgresRunnerStateStore", () => {
  beforeAll(() => migrateSandboxControllerSchema({ url }));

  it("keeps each scope's rows apart, by id and by handle", async () => {
    const stg = postgresRunnerStateStore({ url, scope: "stg" });
    const prod = postgresRunnerStateStore({ url, scope: "prod" });
    const id = sandboxId();
    const handle = `h_${randomUUID()}`;
    try {
      await stg.put(id, { handle, state: { env: "stg" } });
      await prod.put(id, { handle, state: { env: "prod" } });
      expect((await stg.get(id))?.state).toEqual({ env: "stg" });
      expect((await prod.get(id))?.state).toEqual({ env: "prod" });
      expect(await store.get(id)).toBeNull();
      expect((await prod.getByHandle(handle))?.state).toEqual({ env: "prod" });
      expect(await store.getByHandle(handle)).toBeNull();

      await stg.deleteByHandle(handle);
      expect(await stg.get(id)).toBeNull();
      expect((await prod.get(id))?.state).toEqual({ env: "prod" });
      await prod.delete(id);
      expect(await prod.get(id)).toBeNull();
    } finally {
      await stg.close();
      await prod.close();
    }
  });

  it("locks per scope: the same id in another scope is not blocked", async () => {
    const stg = postgresRunnerStateStore({ url, scope: "stg" });
    const prod = postgresRunnerStateStore({
      url,
      scope: "prod",
      lockWaitMs: 2_000,
    });
    const id = sandboxId();
    const held = deferred();
    const release = deferred();
    try {
      const holder = stg.withLock(id, async () => {
        held.resolve();
        await release.promise;
      });
      await held.promise;
      expect(await prod.withLock(id, async () => "free")).toBe("free");
      release.resolve();
      await holder;
    } finally {
      release.resolve();
      await stg.close();
      await prod.close();
    }
  });

  it("upserts, reads by id and by handle, and deletes", async () => {
    const id = sandboxId();
    const handle = `h_${randomUUID()}`;
    expect(await store.get(id)).toBeNull();

    await store.put(id, { handle, state: { token: "a", nested: { n: 1 } } });
    const first = await store.get(id);
    expect(first?.handle).toBe(handle);
    expect(first?.state).toEqual({ token: "a", nested: { n: 1 } });
    expect(first?.updatedAt).toBeInstanceOf(Date);

    const nextHandle = `h_${randomUUID()}`;
    await store.put(id, { handle: nextHandle, state: { token: "b" } });
    expect(await store.getByHandle(handle)).toBeNull();
    const byHandle = await store.getByHandle(nextHandle);
    expect(byHandle).toMatchObject({
      id,
      handle: nextHandle,
      state: { token: "b" },
    });
    expect(byHandle?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      first?.updatedAt.getTime() ?? 0,
    );

    await store.delete(id);
    expect(await store.get(id)).toBeNull();
  });

  it("deleteByHandle removes every row with that handle", async () => {
    const handle = `h_${randomUUID()}`;
    const a = sandboxId();
    const b = sandboxId();
    const other = sandboxId();
    await store.put(a, { handle, state: {} });
    await store.put(b, { handle, state: {} });
    await store.put(other, { handle: `h_${randomUUID()}`, state: {} });

    await store.deleteByHandle(handle);
    expect(await store.get(a)).toBeNull();
    expect(await store.get(b)).toBeNull();
    expect(await store.get(other)).not.toBeNull();
  });

  it("serializes withLock on one sandbox and runs different sandboxes in parallel", async () => {
    const id = sandboxId();
    const holding = deferred();
    const release = deferred();
    const events: string[] = [];

    const first = store.withLock(id, async (ops) => {
      events.push("first:start");
      holding.resolve();
      await release.promise;
      await ops.put(id, { handle: "h1", state: { by: "first" } });
      events.push("first:end");
    });
    await holding.promise;

    const second = store.withLock(id, async (ops) => {
      events.push("second:start");
      return ops.get(id);
    });
    const otherKey = await store.withLock(sandboxId(), async () => "parallel");
    expect(otherKey).toBe("parallel");
    expect(events).toEqual(["first:start"]);

    release.resolve();
    await first;
    expect((await second)?.state).toEqual({ by: "first" });
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    await store.delete(id);
  });

  it("rolls back the lock's writes when the callback throws", async () => {
    const id = sandboxId();
    await expect(
      store.withLock(id, async (ops) => {
        await ops.put(id, { handle: "h", state: {} });
        throw new Error("provisioning failed");
      }),
    ).rejects.toThrow("provisioning failed");
    expect(await store.get(id)).toBeNull();
  });

  it("reports a lock wait past the timeout as lock busy", async () => {
    const id = sandboxId();
    const impatient = postgresRunnerStateStore({ url, lockWaitMs: 200 });
    const holding = deferred();
    const release = deferred();
    try {
      const holder = store.withLock(id, async () => {
        holding.resolve();
        await release.promise;
      });
      await holding.promise;
      await expect(impatient.withLock(id, async () => {})).rejects.toThrow(
        `sandbox advisory lock busy >200ms for user=${id.userId} projectRef=${id.projectRef}`,
      );
      release.resolve();
      await holder;
      expect(await impatient.withLock(id, async () => "free")).toBe("free");
    } finally {
      release.resolve();
      await impatient.close();
    }
  });
});

const SITE = "https://github.com/Acme/Site";
const DOCS = "https://gitlab.com/acme/group/docs";

function poolInput(
  overrides: Partial<{
    name: string;
    tenant: string;
    size: number;
    image: string;
  }> = {},
) {
  return {
    name: `pool-${randomUUID().slice(0, 8)}`,
    tenant: `tenant_${randomUUID()}`,
    size: 4,
    ...overrides,
  };
}

describe("postgresTenantPoolStore", () => {
  beforeAll(() => migrateSandboxControllerSchema({ url }));

  it("creates with defaults, then updates size and image in place", async () => {
    const cluster = `c_${randomUUID()}`;
    const input = poolInput();
    expect(await pools.upsertPool(cluster, input)).toEqual({
      created: true,
      pool: { cluster, ...input, image: "default", repos: [] },
    });

    const updated = await pools.upsertPool(cluster, {
      ...input,
      size: 6,
      image: "android",
    });
    expect(updated).toEqual({
      created: false,
      pool: { cluster, ...input, size: 6, image: "android", repos: [] },
    });
    expect(await pools.list(cluster)).toEqual([updated.pool]);
  });

  it("replaces the repos, round-tripping the normalized URL and the workload", async () => {
    const cluster = `c_${randomUUID()}`;
    const input = poolInput();
    await pools.upsertPool(cluster, input);

    const first = await pools.setRepos(cluster, input.name, [
      {
        repoUrl: "https://x-access-token:secret@GitHub.com/Acme/Site.git",
        replicas: 2,
      },
      {
        repoUrl: DOCS,
        branch: "develop",
        workload: { runtime: "bun", packageManager: "bun", devPort: 3000 },
        replicas: 1,
      },
    ]);
    const expected = {
      cluster,
      ...input,
      image: "default",
      repos: [
        {
          repoUrl: SITE,
          branch: "main",
          workload: { runtime: "node" },
          replicas: 2,
        },
        {
          repoUrl: DOCS,
          branch: "develop",
          workload: { runtime: "bun", packageManager: "bun", devPort: 3000 },
          replicas: 1,
        },
      ],
    };
    expect(first).toEqual(expected);
    expect(await pools.list(cluster)).toEqual([expected]);

    const sql = postgres(url, { max: 1 });
    try {
      const rows = await sql`
        select r.repo_url from sandbox_controller.tenant_pool_repos r
        join sandbox_controller.tenant_pools p on p.id = r.pool_id
        where p.cluster = ${cluster}`;
      expect(JSON.stringify(rows)).not.toContain("secret");
    } finally {
      await sql.end();
    }

    const second = await pools.setRepos(cluster, input.name, [
      { repoUrl: DOCS, replicas: 4 },
    ]);
    expect(second?.repos).toEqual([
      {
        repoUrl: DOCS,
        branch: "main",
        workload: { runtime: "node" },
        replicas: 4,
      },
    ]);
    expect((await pools.setRepos(cluster, input.name, []))?.repos).toEqual([]);
  });

  it("refuses repos over the pool's size, and a shrink below its repos, leaving both as they were", async () => {
    const cluster = `c_${randomUUID()}`;
    const input = poolInput({ size: 3 });
    await pools.upsertPool(cluster, input);
    const held = await pools.setRepos(cluster, input.name, [
      { repoUrl: SITE, replicas: 2 },
    ]);

    await expect(
      pools.setRepos(cluster, input.name, [
        { repoUrl: SITE, replicas: 2 },
        { repoUrl: DOCS, replicas: 2 },
      ]),
    ).rejects.toBeInstanceOf(TenantPoolCapacityError);
    await expect(
      pools.upsertPool(cluster, { ...input, size: 1 }),
    ).rejects.toBeInstanceOf(TenantPoolCapacityError);
    expect(await pools.list(cluster)).toEqual([held!]);
    expect(
      (await pools.upsertPool(cluster, { ...input, size: 2 })).pool.size,
    ).toBe(2);
  });

  it("serializes concurrent writers on the pool row, so their sum never exceeds the size", async () => {
    const cluster = `c_${randomUUID()}`;
    const input = poolInput({ size: 4 });
    await pools.upsertPool(cluster, input);
    await pools.setRepos(cluster, input.name, [{ repoUrl: SITE, replicas: 1 }]);
    const results = await Promise.allSettled([
      pools.setRepos(cluster, input.name, [{ repoUrl: SITE, replicas: 4 }]),
      pools.upsertPool(cluster, { ...input, size: 1 }),
    ]);
    const [pool] = await pools.list(cluster);
    const allocated = pool!.repos.reduce((sum, r) => sum + r.replicas, 0);
    expect(allocated).toBeLessThanOrEqual(pool!.size);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("refuses the same repo and branch twice, and an unknown pool", async () => {
    const cluster = `c_${randomUUID()}`;
    const input = poolInput();
    await pools.upsertPool(cluster, input);
    await expect(
      pools.setRepos(cluster, input.name, [
        { repoUrl: SITE, replicas: 1 },
        { repoUrl: "https://github.com/acme/site", replicas: 1 },
      ]),
    ).rejects.toThrow(/duplicate repo allocation/);
    expect(
      await pools.setRepos(cluster, "no-such-pool", [
        { repoUrl: SITE, replicas: 1 },
      ]),
    ).toBeNull();
  });

  it("refuses a name held by another tenant, leaving the row as it was", async () => {
    const cluster = `c_${randomUUID()}`;
    const input = poolInput();
    const { pool } = await pools.upsertPool(cluster, input);
    const attempt = pools.upsertPool(cluster, {
      ...input,
      tenant: `tenant_${randomUUID()}`,
      size: 9,
    });
    await expect(attempt).rejects.toBeInstanceOf(TenantPoolConflictError);
    await expect(attempt).rejects.toThrow(
      `pool ${input.name} already exists in ${cluster}`,
    );
    expect(await pools.list(cluster)).toEqual([pool]);
  });

  it("rejects invalid input before writing", async () => {
    const cluster = `c_${randomUUID()}`;
    for (const bad of [
      poolInput({ size: 0 }),
      poolInput({ size: 1.5 }),
      poolInput({ name: "Not_A_Label" }),
      poolInput({ name: "a".repeat(55) }),
      poolInput({ tenant: "" }),
      poolInput({ image: "Not An Image" }),
    ]) {
      await expect(pools.upsertPool(cluster, bad)).rejects.toThrow();
    }
    expect(await pools.list(cluster)).toEqual([]);

    const input = poolInput();
    await pools.upsertPool(cluster, input);
    for (const bad of [
      [{ repoUrl: "git@github.com:acme/site.git", replicas: 1 }],
      [{ repoUrl: SITE, replicas: 0 }],
      [{ repoUrl: SITE, branch: "", replicas: 1 }],
    ]) {
      await expect(pools.setRepos(cluster, input.name, bad)).rejects.toThrow();
    }
    expect((await pools.list(cluster))[0]?.repos).toEqual([]);
  });

  it("deletes a pool with its repos, and reports whether a row was removed", async () => {
    const cluster = `c_${randomUUID()}`;
    const input = poolInput();
    await pools.upsertPool(cluster, input);
    await pools.setRepos(cluster, input.name, [{ repoUrl: SITE, replicas: 1 }]);
    expect(await pools.deletePool(cluster, input.name)).toBe(true);
    expect(await pools.deletePool(cluster, input.name)).toBe(false);
    expect(await pools.list(cluster)).toEqual([]);

    await pools.upsertPool(cluster, input);
    expect((await pools.list(cluster))[0]?.repos).toEqual([]);
  });

  it("keeps clusters apart: same name, different tenants, separate deletes", async () => {
    const east = `c_${randomUUID()}`;
    const west = `c_${randomUUID()}`;
    const name = `pool-${randomUUID().slice(0, 8)}`;
    const a = await pools.upsertPool(east, poolInput({ name }));
    const b = await pools.upsertPool(west, poolInput({ name }));
    expect(b.created).toBe(true);
    await pools.setRepos(west, name, [{ repoUrl: SITE, replicas: 1 }]);
    expect(await pools.list(east)).toEqual([a.pool]);

    expect(await pools.deletePool(east, name)).toBe(true);
    expect(await pools.list(east)).toEqual([]);
    expect((await pools.list(west))[0]?.repos).toHaveLength(1);
  });
});

describe("tenantPoolReader", () => {
  beforeAll(() => migrateSandboxControllerSchema({ url }));

  it("picks up a new pool and its repos on refresh and keeps the last list when a load fails", async () => {
    const cluster = `c_${randomUUID()}`;
    const readerStore = postgresTenantPoolStore({ url });
    const reader = tenantPoolReader(readerStore, cluster, {
      refreshMs: 60_000,
    });
    const { current } = reader;
    try {
      expect(await reader.start()).toEqual([]);
      expect(current()).toEqual([]);

      const input = poolInput();
      await pools.upsertPool(cluster, input);
      await pools.setRepos(cluster, input.name, [
        { repoUrl: SITE, replicas: 1 },
      ]);
      await reader.refresh();
      const expected = [
        {
          ...input,
          image: "default",
          repos: [
            {
              repoUrl: SITE,
              branch: "main",
              workload: { runtime: "node" },
              replicas: 1,
            },
          ],
        },
      ];
      expect(current()).toEqual(expected);

      await readerStore.close();
      await pools.upsertPool(cluster, poolInput());
      expect(await reader.refresh()).toEqual(expected);
      expect(current()).toEqual(expected);
    } finally {
      reader.stop();
      await readerStore.close();
    }
  });
});
