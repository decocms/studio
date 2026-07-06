/**
 * RunRegistry — storage-integration tests (real Postgres).
 *
 * The methods exercised here orchestrate real SQL: the reaper's terminal DB
 * write. A previous version mocked the entire
 * ThreadStoragePort and asserted `toHaveBeenCalled`, which proved nothing about
 * the queries themselves. See TESTING.md: don't mock your own code.
 *
 * So `storage` is a real SqlThreadStorage against real Postgres, and we assert
 * the actual row state. The injected callbacks (`resumeFn`, `cancelBroadcast`)
 * are caller-supplied higher-order parameters, not our own modules — capturing
 * their invocations is observing output, the same as reading a row back.
 *
 * The pure in-memory half of RunRegistry (dispatch, getAbortSignal, reaper
 * timing) lives in run-registry.test.ts as a no-I/O unit test.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { StudioDatabase } from "@/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "@/database/test-db-pg";
import type { SSEEvent } from "@/event-bus";
import { SqlThreadStorage } from "@/storage/threads";
import type { Thread } from "@/storage/types";
import { RunRegistry } from "./run-registry";
import type { RunReactorDeps } from "./run-reactor";

const ORG = "org_1";
const USER = "user_1";
// Progress-based reaper idle timeout (run-registry.ts RUN_IDLE_TIMEOUT_MS).
const RUN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

let database: StudioDatabase;
let storage: SqlThreadStorage;
const createdRegistries: RunRegistry[] = [];

beforeAll(async () => {
  database = await connectTestPgDatabase();
});

afterAll(async () => {
  await closeTestPgDatabase(database);
});

beforeEach(async () => {
  await resetTestPgDatabase(database);
  await seedCommonTestPgFixtures(database); // org_1, user_1
  storage = new SqlThreadStorage(database.db);
});

afterEach(() => {
  for (const r of createdRegistries) r.dispose();
  createdRegistries.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(opts: { clock?: () => Date } = {}) {
  const sseEvents: Array<{ orgId: string; event: SSEEvent }> = [];
  const deps: RunReactorDeps = {
    storage,
    sseHub: {
      emit(orgId, event) {
        sseEvents.push({ orgId, event });
      },
    },
  };
  const registry = opts.clock
    ? new RunRegistry(deps, opts.clock)
    : new RunRegistry(deps);
  createdRegistries.push(registry);
  return { registry, sseEvents };
}

function startThread(registry: RunRegistry, taskId: string, orgId = ORG) {
  return registry.dispatch({
    type: "START",
    taskId,
    orgId,
    userId: USER,
    abortController: new AbortController(),
  });
}

/** Create a thread and drive it to in_progress with a non-null run_config. */
async function seedRunningThread(): Promise<Thread> {
  const thread = await storage.create({
    organization_id: ORG,
    created_by: USER,
  });
  await storage.update(thread.id, ORG, {
    status: "in_progress",
    run_config: { resume: true },
    run_started_at: new Date().toISOString(),
  });
  return thread;
}

/** Poll until the predicate holds or we time out (for fire-and-forget writes). */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RunRegistry storage orchestration (real Postgres)", () => {
  describe("stopAll", () => {
    it("aborts in-flight controllers and clears in-memory state", async () => {
      // stopAll no longer writes the DB (no run-owner claim to release) — it
      // aborts the in-flight controllers (which cancels their daemons) and
      // clears the in-memory map. Re-enqueueing the backing DBOS workflows for
      // handoff happens separately in app shutdown.
      const { registry } = makeRegistry();
      const t1 = await seedRunningThread();
      const t2 = await seedRunningThread();
      startThread(registry, t1.id);
      startThread(registry, t2.id);
      const s1 = registry.getAbortSignal(t1.id)!;
      const s2 = registry.getAbortSignal(t2.id)!;

      await registry.stopAll();

      expect(s1.aborted).toBe(true);
      expect(s2.aborted).toBe(true);
      expect(registry.isRunning(t1.id)).toBe(false);
      expect(registry.isRunning(t2.id)).toBe(false);
    });
  });

  describe("reapStaleRuns (terminal side effects)", () => {
    it("reaps a stuck run: real terminal DB write (failed, run_* cleared)", async () => {
      let now = new Date("2024-01-01T00:00:00Z");
      const { registry } = makeRegistry({ clock: () => now });
      const thread = await seedRunningThread();
      startThread(registry, thread.id); // in-memory running, startedAt = now

      const signal = registry.getAbortSignal(thread.id)!;
      // No last_progress_at on the row → reaper baselines off the in-memory
      // startedAt (= the test clock's original `now`). Advance past the idle
      // timeout so the run reads as stuck.
      now = new Date(now.getTime() + RUN_IDLE_TIMEOUT_MS + 1);

      // The reaper is async (reads getProgress per run) — await it so the
      // in-memory eviction + the fire-and-forget terminal write are dispatched.
      await (
        registry as unknown as { reapStaleRuns(): Promise<void> }
      ).reapStaleRuns();

      // In-memory eviction happens inside the awaited sweep.
      expect(signal.aborted).toBe(true);
      expect(registry.isRunning(thread.id)).toBe(false);

      // The terminal write is fire-and-forget inside the reaper — poll until
      // the row is observable. (No JetStream purge on force-fail: the consume
      // step still projects the run and needs the contiguous seq 1..N log.)
      await waitFor(async () => {
        const r = await storage.get(thread.id, ORG);
        return (
          r?.status === "failed" &&
          r.run_owner_pod === null &&
          r.run_config === null &&
          r.run_started_at === null
        );
      });
      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("failed");
      expect(row?.run_owner_pod).toBeNull();
      expect(row?.run_config).toBeNull();
      expect(row?.run_started_at).toBeNull();
    });

    it("does not reap a fresh run when last_progress_at belongs to a previous turn", async () => {
      let now = new Date("2024-01-01T00:00:00Z");
      const { registry } = makeRegistry({ clock: () => now });
      const thread = await seedRunningThread();

      await database.db
        .updateTable("threads")
        .set({
          last_progress_at: new Date(
            now.getTime() - RUN_IDLE_TIMEOUT_MS - 1,
          ).toISOString(),
        })
        .where("id", "=", thread.id)
        .execute();

      startThread(registry, thread.id); // fresh run starts after stale progress
      now = new Date(now.getTime() + RUN_IDLE_TIMEOUT_MS - 1);

      await (
        registry as unknown as { reapStaleRuns(): Promise<void> }
      ).reapStaleRuns();

      expect(registry.isRunning(thread.id)).toBe(true);
      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("in_progress");
    });
  });
});
