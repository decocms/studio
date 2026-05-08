import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SandboxId } from "@decocms/sandbox/runner";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import { KyselySandboxRunnerStateStore } from "./sandbox-runner-state";
import { createTestSchema } from "./test-helpers";

describe("KyselySandboxRunnerStateStore", () => {
  let database: TestDatabase;
  let store: KyselySandboxRunnerStateStore;

  beforeAll(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    store = new KyselySandboxRunnerStateStore(database.db);
  });

  afterAll(async () => {
    await closeTestDatabase(database);
  });

  // Each test uses a unique id to avoid cross-test pollution.
  const mkId = (tag: string): SandboxId => ({
    userId: `user-${tag}`,
    projectRef: `proj-${tag}`,
  });

  it("put + get round-trips all fields", async () => {
    const id = mkId("round-trip");
    const before = Date.now();
    await store.put(id, "docker", {
      handle: "handle-round-trip",
      state: { token: "abc", hostPort: 1234, nested: { k: "v" } },
    });

    const row = await store.get(id, "docker");
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

  it("put UPSERTs on same (user_id, project_ref, runner_kind)", async () => {
    const id = mkId("upsert");
    await store.put(id, "docker", {
      handle: "upsert-handle-1",
      state: { version: 1 },
    });
    await store.put(id, "docker", {
      handle: "upsert-handle-2",
      state: { version: 2 },
    });

    const row = await store.get(id, "docker");
    expect(row).not.toBeNull();
    expect(row!.handle).toBe("upsert-handle-2");
    expect(row!.state).toEqual({ version: 2 });

    // Verify only one row exists for this (user, project, kind).
    const { rows } = await database.pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sandbox_runner_state
         WHERE user_id = $1 AND project_ref = $2 AND runner_kind = $3`,
      [id.userId, id.projectRef, "docker"],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("put allows duplicate handle across different (user, project, kind)", async () => {
    const id1 = mkId("dup-handle-a");
    const id2 = mkId("dup-handle-b");
    const sharedHandle = "shared-handle-conflict";

    await store.put(id1, "docker", {
      handle: sharedHandle,
      state: { which: "a" },
    });

    // Migration 074 dropped the unique constraint on handle — different
    // runners can legitimately share a handle (hash entropy collisions).
    await expect(
      store.put(id2, "freestyle", {
        handle: sharedHandle,
        state: { which: "b" },
      }),
    ).resolves.toBeUndefined();
  });

  it("delete removes the row", async () => {
    const id = mkId("delete");
    await store.put(id, "docker", {
      handle: "delete-handle",
      state: { x: 1 },
    });
    expect(await store.get(id, "docker")).not.toBeNull();

    await store.delete(id, "docker");
    expect(await store.get(id, "docker")).toBeNull();
  });

  it("deleteByHandle removes the row", async () => {
    const id = mkId("delete-by-handle");
    const handle = "delete-by-handle-h";
    await store.put(id, "docker", { handle, state: { x: 1 } });
    expect(await store.get(id, "docker")).not.toBeNull();

    await store.deleteByHandle("docker", handle);
    expect(await store.get(id, "docker")).toBeNull();
  });

  it("getByHandle returns populated row with id", async () => {
    const id = mkId("get-by-handle");
    const handle = "get-by-handle-h";
    await store.put(id, "docker", { handle, state: { token: "t" } });

    const row = await store.getByHandle("docker", handle);
    expect(row).not.toBeNull();
    expect(row!.handle).toBe(handle);
    expect(row!.id).toEqual(id);
    expect(row!.state).toEqual({ token: "t" });
    expect(row!.updatedAt).toBeInstanceOf(Date);
  });

  it("getByHandle returns null when kind does not match", async () => {
    const id = mkId("kind-mismatch");
    const handle = "kind-mismatch-handle";
    await store.put(id, "docker", { handle, state: {} });

    const row = await store.getByHandle("freestyle", handle);
    expect(row).toBeNull();
  });

  it("withLock returns the callback's result and persists writes", async () => {
    const id = mkId("withlock-happy");
    const result = await store.withLock(id, "docker", async (scoped) => {
      await scoped.put(id, "docker", {
        handle: "withlock-happy-handle",
        state: { ok: true },
      });
      return 42;
    });
    expect(result).toBe(42);

    const row = await store.get(id, "docker");
    expect(row).not.toBeNull();
    expect(row!.handle).toBe("withlock-happy-handle");
    expect(row!.state).toEqual({ ok: true });
  });

  it("withLock rolls back on throw", async () => {
    const id = mkId("withlock-throw");
    const boom = new Error("boom");

    await expect(
      store.withLock(id, "docker", async (scoped) => {
        await scoped.put(id, "docker", {
          handle: "withlock-throw-handle",
          state: { bad: true },
        });
        throw boom;
      }),
    ).rejects.toThrow("boom");

    // The put inside the throwing txn must not be visible.
    const row = await store.get(id, "docker");
    expect(row).toBeNull();
  });

  // PGlite does not serialize on pg_advisory_xact_lock: empirically two
  // concurrent transactions that both call pg_advisory_xact_lock(sameKey)
  // proceed in parallel rather than queueing. PGlite is a single-process
  // WASM Postgres without multi-connection lock contention, so this path
  // can only be verified against real Postgres. Real-Postgres coverage is
  // out of scope for this unit test file.
  it.skip("withLock serializes concurrent calls for the same (id, kind) [PGlite does not support pg_advisory_xact_lock]", async () => {
    const id = mkId("withlock-serialize");
    const firstStarted = Promise.withResolvers<void>();
    let secondSawHandle: string | undefined;

    const first = store.withLock(id, "docker", async (scoped) => {
      firstStarted.resolve();
      await scoped.put(id, "docker", {
        handle: "serialize-handleA",
        state: { step: "A" },
      });
      await new Promise((r) => setTimeout(r, 50));
      await scoped.put(id, "docker", {
        handle: "serialize-handleB",
        state: { step: "B" },
      });
      return "first-done";
    });

    const second = (async () => {
      await firstStarted.promise;
      return store.withLock(id, "docker", async (scoped) => {
        const row = await scoped.get(id, "docker");
        secondSawHandle = row?.handle;
        return "second-done";
      });
    })();

    await Promise.all([first, second]);
    expect(secondSawHandle).toBe("serialize-handleB");
  });
});
