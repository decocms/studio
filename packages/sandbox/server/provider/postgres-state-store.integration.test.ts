import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  migrateSandboxControllerSchema,
  postgresRunnerStateStore,
  postgresTenantPoolStore,
  TenantPoolConflictError,
  tenantPoolReader,
  type PostgresRunnerStateStore,
  type PostgresTenantPoolStore,
  type StoredTenantPoolInput,
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
      expect(versions.map((row) => row.version)).toEqual([1, 2]);
      const [tables] = await sql`
        select to_regclass('sandbox_controller.runner_state') as runner_state,
          to_regclass('sandbox_controller.tenant_pools') as tenant_pools`;
      expect(tables?.runner_state).toBe("sandbox_controller.runner_state");
      expect(tables?.tenant_pools).toBe("sandbox_controller.tenant_pools");
    } finally {
      await sql.end();
    }
  });

  it("upgrades a v1-only database to v2 concurrently, keeping its runner state", async () => {
    await migrateSandboxControllerSchema({ url });
    const sql = postgres(url, { max: 1 });
    const id = sandboxId();
    try {
      await sql`drop table sandbox_controller.tenant_pools`;
      await sql`delete from sandbox_controller.migrations where version > 1`;
      await store.put(id, { handle: "h_v1", state: { kept: true } });

      await Promise.all([
        migrateSandboxControllerSchema({ url }),
        migrateSandboxControllerSchema({ url }),
        migrateSandboxControllerSchema({ url }),
      ]);
      await migrateSandboxControllerSchema({ url });

      const versions = await sql`
        select version from sandbox_controller.migrations order by version`;
      expect(versions.map((row) => row.version)).toEqual([1, 2]);
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

function poolInput(
  overrides: Partial<StoredTenantPoolInput> = {},
): StoredTenantPoolInput {
  return {
    name: `pool-${randomUUID().slice(0, 8)}`,
    orgId: `org_${randomUUID()}`,
    repo: "acme/site",
    size: 2,
    ...overrides,
  };
}

describe("postgresTenantPoolStore", () => {
  beforeAll(() => migrateSandboxControllerSchema({ url }));

  it("creates with defaults, then updates the same name in place", async () => {
    const cluster = `c_${randomUUID()}`;
    const input = poolInput();
    const created = await pools.upsert(cluster, input);
    expect(created).toEqual({
      created: true,
      pool: {
        cluster,
        name: input.name,
        orgId: input.orgId,
        repo: "acme/site",
        branch: "main",
        workload: { runtime: "node" },
        size: 2,
      },
    });

    const updated = await pools.upsert(cluster, {
      ...input,
      repo: "Acme/Site",
      branch: "develop",
      connectionId: "conn_1",
      workload: { runtime: "bun", packageManager: "bun", devPort: 3000 },
      size: 5,
    });
    expect(updated).toEqual({
      created: false,
      pool: {
        cluster,
        name: input.name,
        orgId: input.orgId,
        repo: "Acme/Site",
        branch: "develop",
        connectionId: "conn_1",
        workload: { runtime: "bun", packageManager: "bun", devPort: 3000 },
        size: 5,
      },
    });
    expect(await pools.list(cluster)).toEqual([updated.pool]);
  });

  it("refuses a name held by another org or repo, leaving the row as it was", async () => {
    const cluster = `c_${randomUUID()}`;
    const input = poolInput();
    const { pool } = await pools.upsert(cluster, input);

    for (const takeover of [
      { ...input, orgId: `org_${randomUUID()}` },
      { ...input, repo: "acme/other" },
    ]) {
      const attempt = pools.upsert(cluster, { ...takeover, size: 9 });
      await expect(attempt).rejects.toBeInstanceOf(TenantPoolConflictError);
      await expect(attempt).rejects.toThrow(
        `pool ${input.name} already exists in ${cluster}`,
      );
    }
    expect(await pools.list(cluster)).toEqual([pool]);
  });

  it("rejects invalid input before writing", async () => {
    const cluster = `c_${randomUUID()}`;
    for (const bad of [
      poolInput({ size: 0 }),
      poolInput({ size: 1.5 }),
      poolInput({ name: "Not_A_Label" }),
      poolInput({ repo: "no-slash" }),
      poolInput({ orgId: "" }),
    ]) {
      await expect(pools.upsert(cluster, bad)).rejects.toThrow();
    }
    expect(await pools.list(cluster)).toEqual([]);
  });

  it("deletes by name and reports whether a row was removed", async () => {
    const cluster = `c_${randomUUID()}`;
    const input = poolInput();
    await pools.upsert(cluster, input);
    expect(await pools.delete(cluster, input.name)).toBe(true);
    expect(await pools.delete(cluster, input.name)).toBe(false);
    expect(await pools.list(cluster)).toEqual([]);
  });

  it("keeps clusters apart: same name, different tenants, separate deletes", async () => {
    const east = `c_${randomUUID()}`;
    const west = `c_${randomUUID()}`;
    const name = `pool-${randomUUID().slice(0, 8)}`;
    const a = await pools.upsert(east, poolInput({ name }));
    const b = await pools.upsert(west, poolInput({ name, repo: "other/repo" }));
    expect(b.created).toBe(true);
    expect(await pools.list(east)).toEqual([a.pool]);
    expect(await pools.list(west)).toEqual([b.pool]);

    expect(await pools.delete(east, name)).toBe(true);
    expect(await pools.list(east)).toEqual([]);
    expect(await pools.list(west)).toEqual([b.pool]);
  });
});

describe("tenantPoolReader", () => {
  beforeAll(() => migrateSandboxControllerSchema({ url }));

  it("picks up a new pool on refresh and keeps the last list when a load fails", async () => {
    const cluster = `c_${randomUUID()}`;
    const readerStore = postgresTenantPoolStore({ url });
    const reader = tenantPoolReader(readerStore, cluster, {
      refreshMs: 60_000,
    });
    const { current } = reader;
    try {
      expect(await reader.start()).toEqual([]);
      expect(current()).toEqual([]);

      const input = poolInput({ connectionId: "conn_1" });
      await pools.upsert(cluster, input);
      await reader.refresh();
      const expected = [
        {
          name: input.name,
          orgId: input.orgId,
          repo: "acme/site",
          branch: "main",
          connectionId: "conn_1",
          workload: { runtime: "node" },
        },
      ];
      expect(current()).toEqual(expected);

      await readerStore.close();
      await pools.upsert(cluster, poolInput());
      expect(await reader.refresh()).toEqual(expected);
      expect(current()).toEqual(expected);
    } finally {
      reader.stop();
      await readerStore.close();
    }
  });
});
