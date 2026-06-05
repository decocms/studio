/**
 * Integration tests for the observational-sweep thread storage methods.
 * Real Postgres (see test-db-pg.ts) — validates the watermark SQL, which is the
 * riskiest part of the feature.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { MeshDatabase } from "../database";
import { SqlThreadStorage } from "./threads";
import type { ThreadMessage } from "./types";

const ORG = "org_1";
const USER = "user_1";
const OBSERVER = "vir_observer";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

describe("SqlThreadStorage — observational sweep", () => {
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
    await seedCommonTestPgFixtures(database);
    storage = new SqlThreadStorage(database.db);
  });

  // Create a thread, then force the columns the sweep filters on.
  async function makeThread(opts: {
    agentId: string;
    updatedAt: string;
    hidden?: boolean;
    triggerId?: string | null;
    lastObservedAt?: string | null;
  }): Promise<string> {
    const t = await storage.create({
      organization_id: ORG,
      created_by: USER,
      virtual_mcp_id: opts.agentId,
      title: `Thread ${opts.agentId}`,
    });
    await database.db
      .updateTable("threads")
      .set({
        updated_at: opts.updatedAt,
        last_observed_at: opts.lastObservedAt ?? null,
        hidden: opts.hidden ?? false,
        trigger_id: opts.triggerId ?? null,
      })
      .where("id", "=", t.id)
      .execute();
    return t.id;
  }

  function list(
    inactiveBeforeIso = FAR_FUTURE,
    skipAgentIds: string[] = [],
    observeFromIso = "2000-01-01T00:00:00.000Z",
  ) {
    return storage.listObservableThreads({
      organizationId: ORG,
      observerAgentId: OBSERVER,
      skipAgentIds,
      inactiveBeforeIso,
      observeFromIso,
      limit: 50,
    });
  }

  it("excludes observer's own / skip-listed / hidden / observed / empty-agent threads", async () => {
    const normal = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    await makeThread({
      agentId: OBSERVER,
      updatedAt: "2025-01-01T00:00:00.000Z",
    }); // loop
    await makeThread({
      agentId: "vir_skip",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
      hidden: true,
    });
    await makeThread({ agentId: "", updatedAt: "2025-01-01T00:00:00.000Z" });
    // Already observed at its current watermark → excluded.
    await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
      lastObservedAt: "2025-01-01T00:00:00.000Z",
    });
    // Observed, then new activity (watermark < updated_at) → included.
    const reactivated = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-02-01T00:00:00.000Z",
      lastObservedAt: "2025-01-15T00:00:00.000Z",
    });

    const got = await list(FAR_FUTURE, ["vir_skip"]);
    expect(got.map((t) => t.id).sort()).toEqual([normal, reactivated].sort());
  });

  it("only returns threads idle past the cutoff, oldest first", async () => {
    const idleOld = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const idleNewer = await makeThread({
      agentId: "vir_b",
      updatedAt: "2025-06-01T00:00:00.000Z",
    });
    // Active after the cutoff → excluded.
    await makeThread({
      agentId: "vir_c",
      updatedAt: "2027-01-01T00:00:00.000Z",
    });

    const got = await list("2026-01-01T00:00:00.000Z");
    expect(got.map((t) => t.id)).toEqual([idleOld, idleNewer]); // asc by updated_at
  });

  it("markObserved suppresses re-observation until fresh activity arrives", async () => {
    const id = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });

    const before = await list();
    expect(before.map((t) => t.id)).toContain(id);
    const watermark = before.find((t) => t.id === id)!.updated_at;

    await storage.markObserved(id, ORG, watermark);
    const after = await list();
    expect(after.map((t) => t.id)).not.toContain(id);

    // markObserved must NOT bump updated_at (else idle threads look active).
    const row = await database.db
      .selectFrom("threads")
      .select(["updated_at", "last_observed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.last_observed_at as unknown as string).toBe(watermark);

    // New activity bumps updated_at past the watermark → re-qualifies.
    const msg: ThreadMessage = {
      id: "msg_new",
      role: "user",
      parts: [{ type: "text", text: "still here?" }],
      thread_id: id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await storage.saveMessages([msg], ORG);

    const relisted = await list();
    expect(relisted.map((t) => t.id)).toContain(id);
  });

  it("createObservationRunThread creates a visible thread owned by the observer", async () => {
    const sourceId = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });

    const observerThreadId = await storage.createObservationRunThread({
      taskId: "thrd_obs_visible_1",
      organizationId: ORG,
      observerAgentId: OBSERVER,
      observerCreatedBy: USER,
      sourceThreadId: sourceId,
      sourceTitle: "Refund question",
    });

    const row = await database.db
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", observerThreadId)
      .executeTakeFirstOrThrow();

    expect(row.virtual_mcp_id).toBe(OBSERVER);
    expect(row.created_by).toBe(USER);
    expect(row.hidden).toBe(false);
    expect(row.status).toBe("in_progress");
    expect(row.trigger_id).toBeNull();
    expect(row.title).toBe("Observation: Refund question");
    const metadata =
      typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : row.metadata;
    expect(metadata.observation_of).toBe(sourceId);

    // The observer's own thread must never be picked up by the sweep.
    const got = await list();
    expect(got.map((t) => t.id)).not.toContain(observerThreadId);
  });

  it("excludes observation-output threads even when their agent differs from the current observer", async () => {
    // Simulate a PRIOR observer's output thread (different agent id) — e.g.
    // after the admin changed observational_config.agentId. is_observation=true
    // must keep it out regardless of the current observer id.
    const oldObserverThreadId = await storage.createObservationRunThread({
      taskId: "thrd_obs_old",
      organizationId: ORG,
      observerAgentId: "vir_old_observer",
      observerCreatedBy: USER,
      sourceThreadId: "thrd_src_x",
      sourceTitle: "src",
    });

    // Current observer is OBSERVER (!= vir_old_observer), so the agent-id guard
    // would NOT exclude it — only the structural is_observation filter does.
    const got = await list();
    expect(got.map((t) => t.id)).not.toContain(oldObserverThreadId);
  });

  it("createObservationRunThread is idempotent on a repeated taskId (replay-safe)", async () => {
    const sourceId = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const taskId = "thrd_obs_dupe";
    const first = await storage.createObservationRunThread({
      taskId,
      organizationId: ORG,
      observerAgentId: OBSERVER,
      observerCreatedBy: USER,
      sourceThreadId: sourceId,
      sourceTitle: "First",
    });
    const second = await storage.createObservationRunThread({
      taskId,
      organizationId: ORG,
      observerAgentId: OBSERVER,
      observerCreatedBy: USER,
      sourceThreadId: sourceId,
      sourceTitle: "Retry",
    });
    expect(first).toBe(taskId);
    expect(second).toBe(taskId);

    const rows = await database.db
      .selectFrom("threads")
      .select(["id", "title"])
      .where("id", "=", taskId)
      .execute();
    expect(rows).toHaveLength(1); // no duplicate row
    expect(rows[0]?.title).toBe("Observation: First"); // first write wins
  });

  it("observeFromIso makes observation forward-only (no history backfill)", async () => {
    const configuredAt = "2025-03-01T00:00:00.000Z";
    // Active before the observer was configured → never observed.
    const old = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    // Active after configuration → observed.
    const fresh = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-06-01T00:00:00.000Z",
    });

    // Only the thread active at/after configuredAt qualifies — no backfill of
    // the org's pre-existing history.
    expect((await list(FAR_FUTURE, [], configuredAt)).map((t) => t.id)).toEqual(
      [fresh],
    );

    // New activity on the old thread (after config) re-qualifies it — "forward"
    // includes future turns of pre-existing conversations.
    await storage.saveMessages(
      [
        {
          id: "msg_fwd",
          role: "user",
          parts: [{ type: "text", text: "still here?" }],
          thread_id: old,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      ORG,
    );
    expect(
      (await list(FAR_FUTURE, [], configuredAt)).map((t) => t.id),
    ).toContain(old);
  });
});
