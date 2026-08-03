import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SandboxId } from "@decocms/sandbox/provider";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { KyselyAgentSandboxStateStore } from "./sandbox-runner-state";

describe("KyselyAgentSandboxStateStore", () => {
  let database: StudioDatabase;
  let store: KyselyAgentSandboxStateStore;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    store = new KyselyAgentSandboxStateStore(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  // Each test uses a unique id to avoid cross-test pollution.
  const mkId = (tag: string): SandboxId => ({
    userId: `user-${tag}`,
    projectRef: `proj-${tag}`,
  });

  const insertDesktopRow = async (
    id: SandboxId,
    handle: string,
    state: Record<string, unknown> = {},
  ): Promise<void> => {
    await database.pool.query(
      `INSERT INTO sandbox_runner_state
        (user_id, project_ref, sandbox_provider_kind, handle, state)
       VALUES ($1, $2, 'user-desktop', $3, $4::jsonb)`,
      [id.userId, id.projectRef, handle, JSON.stringify(state)],
    );
  };

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

  it("put UPSERTs the AgentSandbox row for the same identity", async () => {
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

  it("put preserves a legacy desktop row with the same handle", async () => {
    const desktopId = mkId("dup-handle-desktop");
    const agentId = mkId("dup-handle-agent");
    const sharedHandle = "shared-handle-conflict";

    await insertDesktopRow(desktopId, sharedHandle, { which: "desktop" });

    // Migration 074 made handles non-unique. The AgentSandbox-only adapter
    // must coexist with, rather than rewrite, persisted desktop rows.
    await expect(
      store.put(agentId, {
        handle: sharedHandle,
        state: { which: "agent" },
      }),
    ).resolves.toBeUndefined();

    const { rows } = await database.pool.query<{ kind: string }>(
      `SELECT sandbox_provider_kind AS kind
       FROM sandbox_runner_state
       WHERE handle = $1
       ORDER BY sandbox_provider_kind`,
      [sharedHandle],
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "agent-sandbox",
      "user-desktop",
    ]);
  });

  it("delete removes the row", async () => {
    const id = mkId("delete");
    await insertDesktopRow(id, "legacy-delete-handle");
    await store.put(id, {
      handle: "delete-handle",
      state: { x: 1 },
    });
    expect(await store.get(id)).not.toBeNull();

    await store.delete(id);
    expect(await store.get(id)).toBeNull();
    const { rows } = await database.pool.query<{ kind: string }>(
      `SELECT sandbox_provider_kind AS kind
       FROM sandbox_runner_state
       WHERE user_id = $1 AND project_ref = $2`,
      [id.userId, id.projectRef],
    );
    expect(rows.map((row) => row.kind)).toEqual(["user-desktop"]);
  });

  it("deleteByHandle removes the row", async () => {
    const id = mkId("delete-by-handle");
    const desktopId = mkId("delete-by-handle-desktop");
    const handle = "delete-by-handle-h";
    await insertDesktopRow(desktopId, handle);
    await store.put(id, { handle, state: { x: 1 } });
    expect(await store.get(id)).not.toBeNull();

    await store.deleteByHandle(handle);
    expect(await store.get(id)).toBeNull();
    const { rows } = await database.pool.query<{ kind: string }>(
      `SELECT sandbox_provider_kind AS kind
       FROM sandbox_runner_state
       WHERE handle = $1`,
      [handle],
    );
    expect(rows.map((row) => row.kind)).toEqual(["user-desktop"]);
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

  it("reads ignore persisted desktop rows", async () => {
    const id = mkId("legacy-desktop");
    const handle = "legacy-desktop-handle";
    await insertDesktopRow(id, handle);

    expect(await store.get(id)).toBeNull();
    expect(await store.getByHandle(handle)).toBeNull();
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
  it.skip("withLock serializes concurrent calls for the same identity [PGlite does not support pg_advisory_xact_lock]", async () => {
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
