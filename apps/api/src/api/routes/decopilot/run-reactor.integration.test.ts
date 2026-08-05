/**
 * Run Reactor — storage-integration tests (real Postgres).
 *
 * The reactor is "the only layer in the pipeline that performs I/O" (see the
 * module header). Its whole contract is the side effects it applies to the
 * threads table — status transitions and clearing the run_* columns on terminal
 * events. A previous version of this file mocked the entire ThreadStoragePort
 * and asserted `toHaveBeenCalledWith(...)`, which only proved the reactor calls
 * the function it calls — it would stay green even if the underlying SQL were
 * broken. See TESTING.md: don't mock your own code.
 *
 * So here `storage` is a real SqlThreadStorage against real Postgres, and we
 * assert the actual row state after each event. The remaining dep — `sseHub` —
 * is an output side-channel (fire-and-forget, the reactor never branches on its
 * return), so we capture its emissions to assert on, the same way an e2e spec
 * reads the DB to assert. That is observing output, not faking an input
 * contract.
 *
 * The reactor performs NO JetStream purge on any event: the consume step
 * projects every dispatched run (its entry guard ignores terminal status) and
 * needs the contiguous seq 1..N log, so purge ownership lives in the projector
 * workflow. `RunReactorDeps` has no stream buffer — the guarantee is
 * structural.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
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
import { reactAll, type RunReactorDeps } from "./run-reactor";
import type { RunEvent } from "./run-state";

const ORG = "org_1";
const USER = "user_1";

let database: StudioDatabase;
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
 * Capturing reactor: real storage, plus in-memory capture of the SSE output
 * side-channel. Returns the deps to pass to reactAll and the captured output.
 */
function makeReactor(): {
  deps: RunReactorDeps;
  sseEvents: Array<{ orgId: string; event: SSEEvent }>;
} {
  const sseEvents: Array<{ orgId: string; event: SSEEvent }> = [];
  const deps: RunReactorDeps = {
    storage,
    sseHub: {
      emit(orgId, event) {
        sseEvents.push({ orgId, event });
      },
    },
  };
  return { deps, sseEvents };
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

/** Drive a thread into in_progress with a non-null run_config. */
async function setInProgress(id: string) {
  await storage.update(id, ORG, {
    status: "in_progress",
    run_config: { resume: true },
    run_started_at: new Date().toISOString(),
  });
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
    it("flips the row to in_progress and emits 1 status event", async () => {
      const { deps, sseEvents } = makeReactor();
      const thread = await createThread(); // default status "completed"
      await database.db
        .updateTable("threads")
        .set({ last_progress_at: new Date(0).toISOString() })
        .where("id", "=", thread.id)
        .where("organization_id", "=", ORG)
        .execute();

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
      const rawRow = await database.db
        .selectFrom("threads")
        .select("last_progress_at")
        .where("id", "=", thread.id)
        .where("organization_id", "=", ORG)
        .executeTakeFirstOrThrow();
      expect(row?.status).toBe("in_progress");
      expect(row?.run_started_at).not.toBeNull();
      expect(rawRow.last_progress_at).toBeNull();
      expect(sseEvents).toHaveLength(1);
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

      // RUN_STARTED bumps updated_at, so compare against the row as it is
      // *after* the write — the source the reactor read from.
      const row = await storage.get(thread.id, ORG);
      const data = statusData(sseEvents[0]!.event);
      expect(data.title).toBe("Test thread");
      expect(data.branch).toBe("main");
      expect(data.created_at).toBe(row?.created_at);
      expect(data.updated_at).toBe(row?.updated_at);
    });
  });

  describe("RUN_RESUMED", () => {
    it("restores in_progress and clears the force-fail columns, keeping run_config; emits 1 event", async () => {
      const { deps, sseEvents } = makeReactor();
      // A run force-failed as ghost/reaped: terminal status, a recorded
      // failure, a stale progress timestamp — but run_config still on the row
      // (resume must keep it). `create()` doesn't persist these columns, so
      // drive the row into that state with an explicit update.
      const thread = await createThread();
      await storage.update(thread.id, ORG, {
        status: "failed",
        failure_reason:
          "Run stalled — no progress within the idle timeout window",
        failure_kind: "stall",
        last_progress_at: "2020-01-01T00:00:00.000Z",
        run_config: { resume: true },
      });

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
      expect(row?.run_started_at).toBeTruthy();
      // The recovered run is executing again — the row must reflect it.
      expect(row?.status).toBe("in_progress");
      // Resume keeps the prior run's config (only START writes a fresh one).
      expect(row?.run_config).toEqual({ resume: true });
      expect(sseEvents).toHaveLength(1);

      // `threadFromDbRow` doesn't surface these columns, so read them raw to
      // prove the write landed (and wasn't dropped by the update() whitelist).
      const raw = await database.db
        .selectFrom("threads")
        .select(["failure_reason", "failure_kind", "last_progress_at"])
        .where("id", "=", thread.id)
        .executeTakeFirst();
      expect(raw?.failure_reason).toBeNull();
      expect(raw?.failure_kind).toBeNull();
      expect(raw?.last_progress_at).toBeNull();
    });
  });

  describe("STEP_COMPLETED", () => {
    it("emits 1 step event and performs no DB write", async () => {
      const { deps, sseEvents } = makeReactor();
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
    });
  });

  describe("RUN_COMPLETED", () => {
    it("does NOT write status to DB (consume step owns it), emits 2 SSE events", async () => {
      const { deps, sseEvents } = makeReactor();
      const thread = await createThread();
      await setInProgress(thread.id);

      await react(
        { type: "RUN_COMPLETED", taskId: thread.id, orgId: ORG, stepCount: 5 },
        deps,
      );

      // The live reactor no longer writes status=completed — the consume step
      // (consume-run-projection.ts) is the sole terminal-status writer. The row
      // should still be in_progress (as set by setInProgress above).
      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("in_progress");
      // run_* columns are also untouched — the consume step clears them.
      expect(row?.run_config).not.toBeNull();
      expect(row?.run_started_at).not.toBeNull();
      // SSE is still emitted for instant UX.
      expect(sseEvents).toHaveLength(2);
    });
  });

  describe("RUN_REQUIRES_ACTION", () => {
    it("does NOT write status to DB (consume step owns it), emits 2 SSE events", async () => {
      const { deps, sseEvents } = makeReactor();
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

      // Same ownership model as RUN_COMPLETED: the consume step owns the terminal
      // DB write; the row stays in_progress here.
      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("in_progress");
      // run_* columns also stay — the consume step clears them.
      expect(row?.run_config).not.toBeNull();
      expect(row?.run_started_at).not.toBeNull();
      // SSE is still emitted for instant UX.
      expect(sseEvents).toHaveLength(2);
    });
  });

  describe("RUN_FAILED", () => {
    it("error/cancelled/reaped: sets status=failed, clears run_* columns, 2 events", async () => {
      for (const reason of ["error", "cancelled", "reaped"] as const) {
        const { deps, sseEvents } = makeReactor();
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
        // `Thread` (storage.get()'s return type) doesn't surface
        // failure_reason/failure_kind — only ThreadUpdateData carries them for
        // writes. Read the raw column directly so this still exercises the
        // real SQL write path (the update() whitelist forwarding) rather than
        // the read-side mapper.
        const dbRow = await database.db
          .selectFrom("threads")
          .select(["failure_reason", "failure_kind"])
          .where("id", "=", thread.id)
          .executeTakeFirstOrThrow();
        // Every non-ghost reason records one, through the real SQL path.
        // Inverted: `error` and `cancelled` used to assert NULL here, which is
        // what left a failed thread row unreadable — `status: failed` with no
        // reason and no kind, so nothing could tell a cancel from a crash.
        expect(dbRow.failure_reason).toBe(
          {
            reaped: "Run stalled — no progress within the idle timeout window",
            cancelled: "Run cancelled before it finished",
            error: "Run ended with an error — see the run's messages",
          }[reason],
        );
        expect(dbRow.failure_kind).toBe(
          { reaped: "stall", cancelled: "cancelled", error: "error" }[reason],
        );
        expect(sseEvents).toHaveLength(2);
      }
    });

    it("ghost: flips an in_progress row to failed (forceFailIfInProgress), clears run_*, 2 events", async () => {
      const { deps, sseEvents } = makeReactor();
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
      expect(sseEvents).toHaveLength(2);
    });

    it("ghost: no-op when the row is NOT in_progress (real forceFailIfInProgress short-circuit)", async () => {
      const { deps, sseEvents } = makeReactor();
      const thread = await createThread(); // status "completed", not in_progress

      await react(
        { type: "RUN_FAILED", taskId: thread.id, orgId: ORG, reason: "ghost" },
        deps,
      );

      const row = await storage.get(thread.id, ORG);
      expect(row?.status).toBe("completed"); // unchanged
      expect(sseEvents).toHaveLength(0);
    });
  });

  describe("PREVIOUS_RUN_ABORTED", () => {
    it("is a no-op: no DB change, no SSE", async () => {
      const { deps, sseEvents } = makeReactor();
      const thread = await createThread();
      await setInProgress(thread.id);
      const before = await storage.get(thread.id, ORG);

      await react(
        { type: "PREVIOUS_RUN_ABORTED", taskId: thread.id, orgId: ORG },
        deps,
      );

      const after = await storage.get(thread.id, ORG);
      expect(after).toEqual(before); // byte-for-byte unchanged
      expect(sseEvents).toHaveLength(0);
    });
  });
});
