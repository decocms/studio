import {
  afterAll,
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
import { SqlThreadStorage } from "@/storage/threads";

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

/** Create an in_progress thread with explicit liveness timestamps. */
async function seedRun(opts: {
  lastProgressAt: string | null;
  runStartedAt: string | null;
}): Promise<string> {
  const thread = await storage.create({
    organization_id: ORG,
    created_by: USER,
  });
  await database.db
    .updateTable("threads")
    .set({
      status: "in_progress",
      last_progress_at: opts.lastProgressAt,
      run_started_at: opts.runStartedAt,
    })
    .where("id", "=", thread.id)
    .execute();
  return thread.id;
}

describe("SqlThreadStorage.listStuckRuns (real Postgres)", () => {
  it("returns only in_progress runs stale past the cutoff (newest of last_progress_at, run_started_at)", async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const cutoff = new Date(now - 45 * 60 * 1000).toISOString();

    const staleByProgress = await seedRun({
      lastProgressAt: iso(60 * 60 * 1000), // 60 min ago → stale
      runStartedAt: iso(70 * 60 * 1000),
    });
    const staleColdStart = await seedRun({
      lastProgressAt: null, // never bumped
      runStartedAt: iso(60 * 60 * 1000), // started 60 min ago → stale via COALESCE
    });
    const healthy = await seedRun({
      lastProgressAt: iso(1 * 60 * 1000), // 1 min ago → fresh
      runStartedAt: iso(60 * 60 * 1000),
    });
    const freshColdStart = await seedRun({
      lastProgressAt: null,
      runStartedAt: iso(1 * 60 * 1000), // started 1 min ago → fresh
    });
    const freshNewTurnWithStaleProgress = await seedRun({
      lastProgressAt: iso(60 * 60 * 1000),
      runStartedAt: iso(1 * 60 * 1000),
    });

    const stuck = await storage.listStuckRuns(cutoff);
    const ids = stuck.map((r) => r.id).sort();

    expect(ids).toEqual([staleByProgress, staleColdStart].sort());
    expect(stuck.every((r) => r.organizationId === ORG)).toBe(true);
    expect(ids).not.toContain(healthy);
    expect(ids).not.toContain(freshColdStart);
    expect(ids).not.toContain(freshNewTurnWithStaleProgress);
  });

  it("ignores non-in_progress threads", async () => {
    const thread = await storage.create({
      organization_id: ORG,
      created_by: USER,
    });
    // default status is "completed"; force a very old progress timestamp anyway
    await database.db
      .updateTable("threads")
      .set({ last_progress_at: new Date(0).toISOString() })
      .where("id", "=", thread.id)
      .execute();

    const stuck = await storage.listStuckRuns(new Date().toISOString());
    expect(stuck.map((r) => r.id)).not.toContain(thread.id);
  });
});

import {
  reapStuckRunsSweep,
  type ThreadGateReaperRuntime,
} from "./thread-gate-reaper";

describe("reapStuckRunsSweep (real Postgres)", () => {
  function realRuntime(): ThreadGateReaperRuntime {
    return {
      listStuckRuns: (cutoffIso) => storage.listStuckRuns(cutoffIso),
      forceFailIfInProgress: (id, org) =>
        storage.forceFailIfInProgress(id, org),
      listOrphanedGateWorkflows: (cutoffMs) =>
        storage.listOrphanedGateWorkflows(cutoffMs),
      cancelGateWorkflow: async () => {},
    };
  }

  it("force-fails only the stuck runs and returns the count", async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();

    const stuck = await seedRun({
      lastProgressAt: iso(60 * 60 * 1000),
      runStartedAt: iso(70 * 60 * 1000),
    });
    const healthy = await seedRun({
      lastProgressAt: iso(60 * 1000),
      runStartedAt: iso(60 * 60 * 1000),
    });

    const reaped = await reapStuckRunsSweep(realRuntime(), now);

    expect(reaped).toBe(1);
    expect((await storage.get(stuck, ORG))?.status).toBe("failed");
    expect((await storage.get(healthy, ORG))?.status).toBe("in_progress");
  });

  it("is idempotent across two sweeps (second sweep reaps nothing)", async () => {
    const now = Date.now();
    await seedRun({
      lastProgressAt: new Date(now - 60 * 60 * 1000).toISOString(),
      runStartedAt: new Date(now - 70 * 60 * 1000).toISOString(),
    });

    expect(await reapStuckRunsSweep(realRuntime(), now)).toBe(1);
    expect(await reapStuckRunsSweep(realRuntime(), now)).toBe(0);
  });
});
