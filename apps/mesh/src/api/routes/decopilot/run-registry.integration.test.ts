/**
 * RunRegistry — storage-integration tests (real Postgres).
 *
 * The methods exercised here orchestrate real SQL: stopAll (orphanRunsByPod),
 * recoverOrphanedRuns + handlePodDeath (listOrphanedRuns* + claimOrphanedRun
 * CAS + forceFailIfInProgress), and the reaper's terminal DB write. A previous
 * version mocked the entire ThreadStoragePort and asserted `toHaveBeenCalled`,
 * which proved nothing about the queries themselves — the orphan filters and
 * the claim CAS would all be untested. See TESTING.md: don't mock your own
 * code.
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
import type { StreamBuffer } from "./stream-buffer";

const ORG = "org_1";
const USER = "user_1";
const POD = "test-pod";
const MAX_RUN_AGE_MS = 30 * 60 * 1000;

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

function makeRegistry(opts: { podId?: string; clock?: () => Date } = {}) {
  const sseEvents: Array<{ orgId: string; event: SSEEvent }> = [];
  const purged: string[] = [];
  const deps: RunReactorDeps = {
    storage,
    sseHub: {
      emit(orgId, event) {
        sseEvents.push({ orgId, event });
      },
    },
    streamBuffer: {
      purge(taskId: string) {
        purged.push(taskId);
      },
    } as unknown as StreamBuffer,
  };
  const podId = opts.podId ?? POD;
  const registry = opts.clock
    ? new RunRegistry(deps, podId, opts.clock)
    : new RunRegistry(deps, podId);
  createdRegistries.push(registry);
  return { registry, sseEvents, purged };
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

/**
 * Create a thread and drive it to in_progress with a non-null run_config (the
 * filter `listOrphanedRuns*` require), owned by `pod` (or orphaned when null).
 */
async function seedRunningThread(pod: string | null): Promise<Thread> {
  const thread = await storage.create({
    organization_id: ORG,
    created_by: USER,
  });
  const claimed = await storage.claimRunStart(
    thread.id,
    ORG,
    {
      status: "in_progress",
      run_owner_pod: pod,
      run_config: { resume: true },
      run_started_at: new Date().toISOString(),
    },
    pod,
  );
  expect(claimed).toBe(true);
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
    it("orphans this pod's in_progress rows in the DB, aborts controllers, clears state", async () => {
      const { registry } = makeRegistry();
      const t1 = await seedRunningThread(POD);
      const t2 = await seedRunningThread(POD);
      startThread(registry, t1.id);
      startThread(registry, t2.id);
      const s1 = registry.getAbortSignal(t1.id)!;
      const s2 = registry.getAbortSignal(t2.id)!;

      await registry.stopAll();

      // DB: run_owner_pod cleared (resumable) but status preserved.
      for (const t of [t1, t2]) {
        const row = await storage.get(t.id, ORG);
        expect(row?.run_owner_pod).toBeNull();
        expect(row?.status).toBe("in_progress");
      }
      // In-memory: controllers aborted and state cleared.
      expect(s1.aborted).toBe(true);
      expect(s2.aborted).toBe(true);
      expect(registry.isRunning(t1.id)).toBe(false);
      expect(registry.isRunning(t2.id)).toBe(false);
    });

    it("still aborts + clears in-memory state when the DB orphan write fails", async () => {
      // Real failure, not a mock: a SqlThreadStorage on a destroyed pool. The
      // contract is that stopAll's try/catch guarantees in-memory cleanup even
      // when orphanRunsByPod throws.
      const brokenDb = await connectTestPgDatabase();
      await closeTestPgDatabase(brokenDb);
      const deps: RunReactorDeps = {
        storage: new SqlThreadStorage(brokenDb.db),
        sseHub: { emit() {} },
        streamBuffer: { purge() {} } as unknown as StreamBuffer,
      };
      const registry = new RunRegistry(deps, POD);
      createdRegistries.push(registry);

      startThread(registry, "t1"); // in-memory only
      const signal = registry.getAbortSignal("t1")!;

      await registry.stopAll(); // must not throw

      expect(signal.aborted).toBe(true);
      expect(registry.isRunning("t1")).toBe(false);
    });
  });

  describe("recoverOrphanedRuns", () => {
    it("claims orphaned in_progress runs to this pod and resumes them", async () => {
      const { registry } = makeRegistry();
      const orphan = await seedRunningThread(null); // null owner = orphan
      const resumed: string[] = [];

      await registry.recoverOrphanedRuns((thread) => {
        resumed.push(thread.id);
        return Promise.resolve();
      });

      expect(resumed).toContain(orphan.id);
      // Real claimOrphanedRun CAS took ownership.
      expect((await storage.get(orphan.id, ORG))?.run_owner_pod).toBe(POD);
    });

    it("force-fails the run when resumeFn throws", async () => {
      const { registry } = makeRegistry();
      const orphan = await seedRunningThread(null);

      await registry.recoverOrphanedRuns(() =>
        Promise.reject(new Error("boom")),
      );

      // Real forceFailIfInProgress flipped the row.
      expect((await storage.get(orphan.id, ORG))?.status).toBe("failed");
    });

    it("does nothing when there are no orphaned runs", async () => {
      const { registry } = makeRegistry();
      let called = false;

      await registry.recoverOrphanedRuns(() => {
        called = true;
        return Promise.resolve();
      });

      expect(called).toBe(false);
    });

    // NOTE: the "lost the claim CAS to another pod" branch (claimOrphanedRun
    // returns false → skip resume) is genuine cross-pod contention and can't be
    // reproduced deterministically single-pod — the orphan list only contains
    // in_progress rows, which claimOrphanedRun always wins in isolation. That
    // branch belongs to the multi-pod suite.
  });

  describe("handlePodDeath", () => {
    it("claims + resumes every orphan owned by the dead pod and broadcasts cancel", async () => {
      const { registry } = makeRegistry();
      const orphans = [
        await seedRunningThread("dead-pod"),
        await seedRunningThread("dead-pod"),
        await seedRunningThread("dead-pod"),
      ];
      const resumed: string[] = [];
      const broadcasted: string[] = [];

      await registry.handlePodDeath(
        "dead-pod",
        (thread) => {
          resumed.push(thread.id);
          return Promise.resolve();
        },
        { broadcast: (id) => broadcasted.push(id) },
      );

      const ids = orphans.map((t) => t.id).sort();
      expect(resumed.sort()).toEqual(ids);
      expect(broadcasted.sort()).toEqual(ids);
      for (const t of orphans) {
        expect((await storage.get(t.id, ORG))?.run_owner_pod).toBe(POD);
      }
    });

    it("force-fails the run when resumeFn throws", async () => {
      const { registry } = makeRegistry();
      const orphan = await seedRunningThread("dead-pod");

      await registry.handlePodDeath("dead-pod", () =>
        Promise.reject(new Error("boom")),
      );

      expect((await storage.get(orphan.id, ORG))?.status).toBe("failed");
    });

    it("no-ops when the dead pod owns no in_progress runs", async () => {
      const { registry } = makeRegistry();
      // Seeded run is owned by a different, live pod.
      await seedRunningThread("other-pod");
      let called = false;

      await registry.handlePodDeath("dead-pod", () => {
        called = true;
        return Promise.resolve();
      });

      expect(called).toBe(false);
    });
  });

  describe("reapStaleRuns (terminal side effects)", () => {
    it("reaps a stale run: real terminal DB write (failed, run_* cleared) + purge", async () => {
      let now = new Date("2024-01-01T00:00:00Z");
      const { registry, purged } = makeRegistry({ clock: () => now });
      const thread = await seedRunningThread(POD);
      startThread(registry, thread.id); // in-memory running, startedAt = now

      const signal = registry.getAbortSignal(thread.id)!;
      now = new Date(now.getTime() + MAX_RUN_AGE_MS + 1);

      (registry as unknown as { reapStaleRuns(): void }).reapStaleRuns();

      // In-memory eviction is synchronous.
      expect(signal.aborted).toBe(true);
      expect(registry.isRunning(thread.id)).toBe(false);

      // The terminal write + purge are fire-and-forget inside the reaper, and
      // the reactor calls streamBuffer.purge() on the line *after* the status
      // write commits. Poll until BOTH the row and the purge are observable —
      // asserting purge the instant status flips to "failed" is a race (it
      // passed locally and in CI for #3579, then flaked here).
      await waitFor(async () => {
        const r = await storage.get(thread.id, ORG);
        return (
          r?.status === "failed" &&
          r.run_owner_pod === null &&
          r.run_config === null &&
          r.run_started_at === null &&
          purged.includes(thread.id)
        );
      });
      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("failed");
      expect(row?.run_owner_pod).toBeNull();
      expect(row?.run_config).toBeNull();
      expect(row?.run_started_at).toBeNull();
      expect(purged).toContain(thread.id);
    });
  });
});
