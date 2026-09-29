import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  migrateRunnerStateStore,
  postgresRunnerStateStore,
  type PostgresRunnerStateStore,
} from "./postgres-state-store";
import type { SandboxId } from "./types";

const adminUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";
const database = `sbx_store_test_${randomUUID().replaceAll("-", "")}`;
const url = Object.assign(new URL(adminUrl), { pathname: `/${database}` }).href;

const admin = postgres(adminUrl, { max: 1 });
let store: PostgresRunnerStateStore;

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
});

afterAll(async () => {
  await store.close();
  await admin.unsafe(`drop database if exists ${database} with (force)`);
  await admin.end();
});

describe("migrateRunnerStateStore", () => {
  it("runs concurrently and again without reapplying a version", async () => {
    await Promise.all([
      migrateRunnerStateStore({ url }),
      migrateRunnerStateStore({ url }),
      migrateRunnerStateStore({ url }),
    ]);
    await migrateRunnerStateStore({ url });

    const sql = postgres(url, { max: 1 });
    try {
      const versions = await sql`
        select version from sandbox_controller.migrations order by version`;
      expect(versions.map((row) => row.version)).toEqual([1]);
      const [table] = await sql`
        select to_regclass('sandbox_controller.runner_state') as name`;
      expect(table?.name).toBe("sandbox_controller.runner_state");
    } finally {
      await sql.end();
    }
  });
});

describe("postgresRunnerStateStore", () => {
  beforeAll(() => migrateRunnerStateStore({ url }));

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
