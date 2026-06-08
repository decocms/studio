/**
 * Integration tests for the observational-sweep thread storage methods.
 * Real Postgres (see test-db-pg.ts) — validates the watermark SQL, which is the
 * riskiest part of the feature. Watermarks live in the normalized
 * thread_observations table, keyed per (thread, observer).
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
const OBSERVER = "vir_observer"; // observer agent id (loop-prevention exclusion)
const OBSERVER_ID = "obs_1"; // observer config id (watermark key)
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
        hidden: opts.hidden ?? false,
        trigger_id: opts.triggerId ?? null,
      })
      .where("id", "=", t.id)
      .execute();
    return t.id;
  }

  function list(
    inactiveBeforeIso = FAR_FUTURE,
    scopeAgentIds: string[] = [],
    observeFromIso = "2000-01-01T00:00:00.000Z",
    scopeMode: "all" | "only" = "all",
    observerId = OBSERVER_ID,
  ) {
    return storage.listObservableThreads({
      organizationId: ORG,
      observerId,
      observerAgentId: OBSERVER,
      scopeMode,
      scopeAgentIds,
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
    const observed = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    await storage.markObserved(
      observed,
      OBSERVER_ID,
      "2025-01-01T00:00:00.000Z",
    );
    // Observed, then new activity (watermark < updated_at) → included.
    const reactivated = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-02-01T00:00:00.000Z",
    });
    await storage.markObserved(
      reactivated,
      OBSERVER_ID,
      "2025-01-15T00:00:00.000Z",
    );

    const got = await list(FAR_FUTURE, ["vir_skip"]);
    expect(got.map((t) => t.id).sort()).toEqual([normal, reactivated].sort());
  });

  it("scopeMode 'only' observes just the allowlisted agents", async () => {
    const a = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const b = await makeThread({
      agentId: "vir_b",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    await makeThread({
      agentId: "vir_c",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });

    // Allowlist [vir_a, vir_b] → only those (vir_c excluded).
    const got = await list(FAR_FUTURE, ["vir_a", "vir_b"], undefined, "only");
    expect(got.map((t) => t.id).sort()).toEqual([a, b].sort());

    // Empty allowlist → observe nothing.
    const none = await list(FAR_FUTURE, [], undefined, "only");
    expect(none).toHaveLength(0);
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

    await storage.markObserved(id, OBSERVER_ID, watermark);
    const after = await list();
    expect(after.map((t) => t.id)).not.toContain(id);

    // The watermark is recorded in thread_observations, not on the thread.
    const obs = await database.db
      .selectFrom("thread_observations")
      .select("last_observed_at")
      .where("thread_id", "=", id)
      .where("observer_id", "=", OBSERVER_ID)
      .executeTakeFirstOrThrow();
    expect(obs.last_observed_at).toBe(watermark);

    // markObserved must NOT bump updated_at (else idle threads look active).
    const row = await database.db
      .selectFrom("threads")
      .select("updated_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.updated_at as unknown as string).toBe(watermark);

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

  it("tracks each observer's watermark independently", async () => {
    const id = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const OBSERVER_B = "obs_2";

    // Observer A observes it; observer B has not.
    await storage.markObserved(id, OBSERVER_ID, "2025-01-01T00:00:00.000Z");

    expect((await list()).map((t) => t.id)).not.toContain(id); // A: done
    expect(
      (await list(FAR_FUTURE, [], undefined, "all", OBSERVER_B)).map(
        (t) => t.id,
      ),
    ).toContain(id); // B: still pending

    // B observes it too → now excluded for both observers.
    await storage.markObserved(id, OBSERVER_B, "2025-01-01T00:00:00.000Z");
    expect(
      (await list(FAR_FUTURE, [], undefined, "all", OBSERVER_B)).map(
        (t) => t.id,
      ),
    ).not.toContain(id);
  });

  it("markObserved is an upsert — re-observing a thread updates its watermark", async () => {
    const id = await makeThread({
      agentId: "vir_a",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    await storage.markObserved(id, OBSERVER_ID, "2025-01-01T00:00:00.000Z");
    await storage.markObserved(id, OBSERVER_ID, "2025-02-01T00:00:00.000Z");

    const rows = await database.db
      .selectFrom("thread_observations")
      .select("last_observed_at")
      .where("thread_id", "=", id)
      .where("observer_id", "=", OBSERVER_ID)
      .execute();
    expect(rows).toHaveLength(1); // upsert, not a second row
    expect(rows[0]?.last_observed_at).toBe("2025-02-01T00:00:00.000Z");
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
    // after the admin changed the observer agent. is_observation=true must keep
    // it out regardless of the current observer id.
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
