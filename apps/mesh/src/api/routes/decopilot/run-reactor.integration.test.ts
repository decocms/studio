/**
 * Run Reactor — storage-integration tests (real Postgres).
 *
 * The reactor is "the only layer in the pipeline that performs I/O" (see the
 * module header). Its whole contract is the side effects it applies to the
 * threads table — claim-on-start CAS, status transitions, and clearing the
 * run_* columns on terminal events. A previous version of this file mocked
 * the entire ThreadStoragePort and asserted `toHaveBeenCalledWith(...)`, which
 * only proved the reactor calls the function it calls — it would stay green
 * even if `claimRunStart`'s CAS SQL were broken, the exact bug that layer can
 * have. See TESTING.md: don't mock your own code.
 *
 * So here `storage` is a real SqlThreadStorage against real Postgres, and we
 * assert the actual row state after each event. The two remaining deps —
 * `sseHub` and `streamBuffer` — are output side-channels (fire-and-forget,
 * the reactor never branches on their return), so we capture their emissions
 * to assert on, the same way an e2e spec reads the DB to assert. That is
 * observing output, not faking an input contract.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import type { MeshDatabase } from "@/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "@/database/test-db-pg";
import type { SSEEvent } from "@/event-bus";
import { SqlThreadStorage } from "@/storage/threads";
import type { Thread } from "@/storage/types";
import { reactAll, RunClaimError, type RunReactorDeps } from "./run-reactor";
import type { RunEvent } from "./run-state";
import type { StreamBuffer } from "./stream-buffer";

const ORG = "org_1";
const USER = "user_1";

let database: MeshDatabase;
let storage: SqlThreadStorage;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capturing reactor: real storage, plus in-memory capture of the two output
 * side-channels. Returns the deps to pass to reactAll and the captured output.
 */
function makeReactor(): {
  deps: RunReactorDeps;
  sseEvents: Array<{ orgId: string; event: SSEEvent }>;
  purged: string[];
} {
  const sseEvents: Array<{ orgId: string; event: SSEEvent }> = [];
  const purged: string[] = [];
  const deps: RunReactorDeps = {
    storage,
    sseHub: {
      emit(orgId, event) {
        sseEvents.push({ orgId, event });
      },
    },
    // Only purge() is exercised by the reactor; capture it.
    streamBuffer: {
      purge(taskId: string) {
        purged.push(taskId);
      },
    } as unknown as StreamBuffer,
  };
  return { deps, sseEvents, purged };
}

const react = (event: RunEvent, deps: RunReactorDeps) =>
  reactAll([{ event, state: undefined }], deps);

function createThread(overrides: Partial<Thread> = {}) {
  return storage.create({
    organization_id: ORG,
    created_by: USER,
    ...overrides,
  });
}

/** Drive a thread into in_progress, owned by `pod`, with a non-null run_config. */
async function setInProgress(id: string, pod = "pod-1") {
  const claimed = await storage.claimRunStart(
    id,
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
}

/** Status-event payloads carry thread metadata on `data`. */
function statusData(event: SSEEvent): Record<string, unknown> {
  return (event as unknown as { data: Record<string, unknown> }).data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reactAll (real Postgres)", () => {
  describe("RUN_STARTED", () => {
    it("claims the run via real CAS: row flips to in_progress, 1 status event", async () => {
      const { deps, sseEvents, purged } = makeReactor();
      const thread = await createThread(); // default status "completed"

      await react(
        {
          type: "RUN_STARTED",
          taskId: thread.id,
          orgId: ORG,
          userId: USER,
          abortController: new AbortController(),
        },
        deps,
      );

      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("in_progress");
      // No podId on the event → owner pod and started_at stay null.
      expect(row?.run_owner_pod).toBeNull();
      expect(row?.run_started_at).toBeNull();
      expect(sseEvents).toHaveLength(1);
      expect(purged).toHaveLength(0);
    });

    it("emitted status event reflects the real row (title, branch, created_at, updated_at)", async () => {
      const { deps, sseEvents } = makeReactor();
      const thread = await createThread({
        title: "Test thread",
        branch: "main",
        virtual_mcp_id: "vmcp-1",
      });

      await react(
        {
          type: "RUN_STARTED",
          taskId: thread.id,
          orgId: ORG,
          userId: USER,
          abortController: new AbortController(),
        },
        deps,
      );

      // claimRunStart bumps updated_at, so compare against the row as it is
      // *after* the claim — the source the reactor read from.
      const row = await storage.get(thread.id, ORG);
      const data = statusData(sseEvents[0]!.event);
      expect(data.title).toBe("Test thread");
      expect(data.branch).toBe("main");
      expect(data.created_at).toBe(row?.created_at);
      expect(data.updated_at).toBe(row?.updated_at);
    });

    it("throws RunClaimError on real CAS contention (already running on another pod)", async () => {
      const { deps, sseEvents } = makeReactor();
      const thread = await createThread();
      await setInProgress(thread.id, "pod-other");

      // Event carries no podId → CAS cannot match the foreign pod → 0 rows.
      await expect(
        react(
          {
            type: "RUN_STARTED",
            taskId: thread.id,
            orgId: ORG,
            userId: USER,
            abortController: new AbortController(),
          },
          deps,
        ),
      ).rejects.toBeInstanceOf(RunClaimError);

      expect(sseEvents).toHaveLength(0);
      // Row is untouched — still owned by the other pod.
      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("in_progress");
      expect(row?.run_owner_pod).toBe("pod-other");
    });
  });

  describe("RUN_RESUMED", () => {
    it("sets run_owner_pod + run_started_at WITHOUT touching status; emits 1 event", async () => {
      const { deps, sseEvents, purged } = makeReactor();
      const thread = await createThread(); // status "completed"

      await react(
        {
          type: "RUN_RESUMED",
          taskId: thread.id,
          orgId: ORG,
          userId: USER,
          abortController: new AbortController(),
          podId: "pod-1",
        },
        deps,
      );

      const row = await storage.get(thread.id, ORG);
      expect(row?.run_owner_pod).toBe("pod-1");
      expect(row?.run_started_at).toBeTruthy();
      // Proof the status column was never written: it stays "completed".
      expect(row?.status).toBe("completed");
      expect(sseEvents).toHaveLength(1);
      expect(purged).toHaveLength(0);
    });
  });

  describe("STEP_COMPLETED", () => {
    it("emits 1 step event and performs no DB write", async () => {
      const { deps, sseEvents, purged } = makeReactor();
      const thread = await createThread();
      const before = await storage.get(thread.id, ORG);

      await react(
        { type: "STEP_COMPLETED", taskId: thread.id, orgId: ORG, stepCount: 3 },
        deps,
      );

      const after = await storage.get(thread.id, ORG);
      expect(after?.updated_at).toBe(before?.updated_at); // untouched
      expect(after?.status).toBe(before?.status);
      expect(sseEvents).toHaveLength(1);
      expect(purged).toHaveLength(0);
    });
  });

  describe("RUN_COMPLETED", () => {
    it("sets status=completed, clears run_* columns, purges, emits 2 events", async () => {
      const { deps, sseEvents, purged } = makeReactor();
      const thread = await createThread();
      await setInProgress(thread.id);

      await react(
        { type: "RUN_COMPLETED", taskId: thread.id, orgId: ORG, stepCount: 5 },
        deps,
      );

      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("completed");
      expect(row?.run_owner_pod).toBeNull();
      expect(row?.run_config).toBeNull();
      expect(row?.run_started_at).toBeNull();
      expect(purged).toEqual([thread.id]);
      expect(sseEvents).toHaveLength(2);
    });
  });

  describe("RUN_REQUIRES_ACTION", () => {
    it("sets status=requires_action, clears run_* columns, purges, emits 2 events", async () => {
      const { deps, sseEvents, purged } = makeReactor();
      const thread = await createThread();
      await setInProgress(thread.id);

      await react(
        {
          type: "RUN_REQUIRES_ACTION",
          taskId: thread.id,
          orgId: ORG,
          stepCount: 4,
        },
        deps,
      );

      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("requires_action");
      expect(row?.run_owner_pod).toBeNull();
      expect(row?.run_config).toBeNull();
      expect(row?.run_started_at).toBeNull();
      expect(purged).toEqual([thread.id]);
      expect(sseEvents).toHaveLength(2);
    });
  });

  describe("RUN_FAILED", () => {
    it("error/cancelled/reaped: sets status=failed, clears run_* columns, purges, 2 events", async () => {
      for (const reason of ["error", "cancelled", "reaped"] as const) {
        const { deps, sseEvents, purged } = makeReactor();
        const thread = await createThread();
        await setInProgress(thread.id);

        await react(
          { type: "RUN_FAILED", taskId: thread.id, orgId: ORG, reason },
          deps,
        );

        const row = await storage.get(thread.id, ORG);
        expect(row?.status).toBe("failed");
        expect(row?.run_owner_pod).toBeNull();
        expect(row?.run_config).toBeNull();
        expect(row?.run_started_at).toBeNull();
        expect(purged).toEqual([thread.id]);
        expect(sseEvents).toHaveLength(2);
      }
    });

    it("ghost: flips an in_progress row to failed (forceFailIfInProgress), clears run_*, purges, 2 events", async () => {
      const { deps, sseEvents, purged } = makeReactor();
      const thread = await createThread();
      await setInProgress(thread.id);

      await react(
        { type: "RUN_FAILED", taskId: thread.id, orgId: ORG, reason: "ghost" },
        deps,
      );

      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("failed");
      expect(row?.run_owner_pod).toBeNull();
      expect(row?.run_config).toBeNull();
      expect(row?.run_started_at).toBeNull();
      expect(purged).toEqual([thread.id]);
      expect(sseEvents).toHaveLength(2);
    });

    it("ghost: no-op when the row is NOT in_progress (real forceFailIfInProgress short-circuit)", async () => {
      const { deps, sseEvents, purged } = makeReactor();
      const thread = await createThread(); // status "completed", not in_progress

      await react(
        { type: "RUN_FAILED", taskId: thread.id, orgId: ORG, reason: "ghost" },
        deps,
      );

      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("completed"); // unchanged
      expect(purged).toHaveLength(0);
      expect(sseEvents).toHaveLength(0);
    });
  });

  describe("PREVIOUS_RUN_ABORTED", () => {
    it("is a no-op: no DB change, no purge, no SSE", async () => {
      const { deps, sseEvents, purged } = makeReactor();
      const thread = await createThread();
      await setInProgress(thread.id);
      const before = await storage.get(thread.id, ORG);

      await react(
        { type: "PREVIOUS_RUN_ABORTED", taskId: thread.id, orgId: ORG },
        deps,
      );

      const after = await storage.get(thread.id, ORG);
      expect(after).toEqual(before); // byte-for-byte unchanged
      expect(purged).toHaveLength(0);
      expect(sseEvents).toHaveLength(0);
    });
  });

  describe("reactAll error propagation", () => {
    it("stops on the first thrown error; later events are not processed", async () => {
      const { deps, sseEvents } = makeReactor();
      const thread = await createThread();
      await setInProgress(thread.id);

      // First event: RUN_STARTED for a thread that doesn't exist → claimRunStart
      // updates 0 rows → RunClaimError. Second event would complete `thread`.
      await expect(
        reactAll(
          [
            {
              event: {
                type: "RUN_STARTED",
                taskId: "thrd_does_not_exist",
                orgId: ORG,
                userId: USER,
                abortController: new AbortController(),
              },
              state: undefined,
            },
            {
              event: {
                type: "RUN_COMPLETED",
                taskId: thread.id,
                orgId: ORG,
                stepCount: 1,
              },
              state: undefined,
            },
          ],
          deps,
        ),
      ).rejects.toBeInstanceOf(RunClaimError);

      // The RUN_COMPLETED never ran: `thread` is still in_progress.
      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("in_progress");
      expect(sseEvents).toHaveLength(0);
    });
  });
});
