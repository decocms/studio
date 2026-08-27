import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SandboxId } from "@decocms/sandbox/provider";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { KyselySandboxProviderStateStore } from "./sandbox-runner-state";

describe("KyselySandboxProviderStateStore", () => {
  let database: StudioDatabase;
  let store: KyselySandboxProviderStateStore;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    store = new KyselySandboxProviderStateStore(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  // Each test uses a unique id to avoid cross-test pollution.
  const mkId = (tag: string): SandboxId => ({
    userId: `user-${tag}`,
    projectRef: `proj-${tag}`,
  });

  it("put + get round-trips all fields", async () => {
    const id = mkId("round-trip");
    const before = Date.now();
    await store.put(id, {
      handle: "handle-round-trip",
      state: { token: "abc", hostPort: 1234, nested: { k: "v" } },
    });

    const row = await store.get(id);
    expect(row).not.toBeNull();
    expect(row!.handle).toBe("handle-round-trip");
    expect(row!.state).toEqual({
      token: "abc",
      hostPort: 1234,
      nested: { k: "v" },
    });
    expect(row!.updatedAt).toBeInstanceOf(Date);
    // updatedAt should be recent (within a reasonable window).
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.updatedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("put UPSERTs on the same sandbox id", async () => {
    const id = mkId("upsert");
    await store.put(id, {
      handle: "upsert-handle-1",
      state: { version: 1 },
    });
    await store.put(id, {
      handle: "upsert-handle-2",
      state: { version: 2 },
    });

    const row = await store.get(id);
    expect(row).not.toBeNull();
    expect(row!.handle).toBe("upsert-handle-2");
    expect(row!.state).toEqual({ version: 2 });

    // Verify only one row exists for this (user, project, kind).
    const { rows } = await database.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sandbox_runner_state
         WHERE user_id = $1 AND project_ref = $2 AND sandbox_provider_kind = $3`,
      [id.userId, id.projectRef, "agent-sandbox"],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("put allows duplicate handle across different sandbox ids", async () => {
    const id1 = mkId("dup-handle-a");
    const id2 = mkId("dup-handle-b");
    const sharedHandle = "shared-handle-conflict";

    await store.put(id1, {
      handle: sharedHandle,
      state: { which: "a" },
    });

    // Migration 074 dropped the unique constraint on handle, so distinct
    // logical sandbox ids may share one (for example after a hash collision).
    await expect(
      store.put(id2, {
        handle: sharedHandle,
        state: { which: "b" },
      }),
    ).resolves.toBeUndefined();
  });

  it("delete removes the row", async () => {
    const id = mkId("delete");
    await store.put(id, {
      handle: "delete-handle",
      state: { x: 1 },
    });
    expect(await store.get(id)).not.toBeNull();

    await store.delete(id);
    expect(await store.get(id)).toBeNull();
  });

  it("deleteByHandle removes the row", async () => {
    const id = mkId("delete-by-handle");
    const handle = "delete-by-handle-h";
    await store.put(id, { handle, state: { x: 1 } });
    expect(await store.get(id)).not.toBeNull();

    await store.deleteByHandle(handle);
    expect(await store.get(id)).toBeNull();
  });

  it("getByHandle returns populated row with id", async () => {
    const id = mkId("get-by-handle");
    const handle = "get-by-handle-h";
    await store.put(id, { handle, state: { token: "t" } });

    const row = await store.getByHandle(handle);
    expect(row).not.toBeNull();
    expect(row!.handle).toBe(handle);
    expect(row!.id).toEqual(id);
    expect(row!.state).toEqual({ token: "t" });
    expect(row!.updatedAt).toBeInstanceOf(Date);
  });

  it("withLock returns the callback's result and persists writes", async () => {
    const id = mkId("withlock-happy");
    const result = await store.withLock(id, async (scoped) => {
      await scoped.put(id, {
        handle: "withlock-happy-handle",
        state: { ok: true },
      });
      return 42;
    });
    expect(result).toBe(42);

    const row = await store.get(id);
    expect(row).not.toBeNull();
    expect(row!.handle).toBe("withlock-happy-handle");
    expect(row!.state).toEqual({ ok: true });
  });

  it("withLock rolls back on throw", async () => {
    const id = mkId("withlock-throw");
    const boom = new Error("boom");

    await expect(
      store.withLock(id, async (scoped) => {
        await scoped.put(id, {
          handle: "withlock-throw-handle",
          state: { bad: true },
        });
        throw boom;
      }),
    ).rejects.toThrow("boom");

    // The put inside the throwing txn must not be visible.
    const row = await store.get(id);
    expect(row).toBeNull();
  });

  // PGlite does not serialize on pg_advisory_xact_lock: empirically two
  // concurrent transactions that both call pg_advisory_xact_lock(sameKey)
  // proceed in parallel rather than queueing. PGlite is a single-process
  // WASM Postgres without multi-connection lock contention, so this path
  // can only be verified against real Postgres. Real-Postgres coverage is
  // out of scope for this unit test file.
  it.skip("withLock serializes concurrent calls for the same id [PGlite does not support pg_advisory_xact_lock]", async () => {
    const id = mkId("withlock-serialize");
    const firstStarted = Promise.withResolvers<void>();
    let secondSawHandle: string | undefined;

    const first = store.withLock(id, async (scoped) => {
      firstStarted.resolve();
      await scoped.put(id, {
        handle: "serialize-handleA",
        state: { step: "A" },
      });
      await new Promise((r) => setTimeout(r, 50));
      await scoped.put(id, {
        handle: "serialize-handleB",
        state: { step: "B" },
      });
      return "first-done";
    });

    const second = (async () => {
      await firstStarted.promise;
      return store.withLock(id, async (scoped) => {
        const row = await scoped.get(id);
        secondSawHandle = row?.handle;
        return "second-done";
      });
    })();

    await Promise.all([first, second]);
    expect(secondSawHandle).toBe("serialize-handleB");
  });
});
