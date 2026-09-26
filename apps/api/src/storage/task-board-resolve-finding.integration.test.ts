import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { sleep } from "@decocms/shared/std";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { NotificationStorage } from "./notifications";
import { TaskBoardStorage } from "./task-board";

/**
 * Real-Postgres coverage for `resolveFinding`, the storage half of
 * `POST /api/:org/internal/task-board/resolve`. It pins which cards close,
 * which only get the note, which are left alone, and that a run id writes at
 * most once per card. The first test also proves that the live CHECK
 * constraint from migration 227 accepts `finding_resolved`.
 */
const ORG = "org_resolve_finding";
const OTHER_ORG = "org_resolve_finding_other";
const MEMBER = "user_resolve_finding";
const SOURCE = { url: "https://shop.example/", runId: "run_1" };

describe("TaskBoardStorage.resolveFinding", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
  });

  beforeEach(async () => {
    await resetTestPgDatabase(database);
    const createdAt = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${MEMBER}, ${`${MEMBER}@test.com`}, false, ${MEMBER}, ${createdAt}, ${createdAt})
    `.execute(database.db);
    await database.db
      .insertInto("organization")
      .values([
        { id: ORG, name: ORG, slug: "resolve-finding", createdAt },
        { id: OTHER_ORG, name: OTHER_ORG, slug: "resolve-other", createdAt },
      ])
      .execute();
    storage = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  /** A card the reports import would have pushed. */
  const reportsCard = (status?: string, organizationId = ORG) =>
    storage.create({
      organizationId,
      title: "Add an H1 to the home page",
      status,
      externalKey: "diag:shop.example:SEO-001",
      by: "system",
    });

  const resolve = (id: string, runId = SOURCE.runId, organizationId = ORG) =>
    storage.resolveFinding({ id, organizationId, url: SOURCE.url, runId });

  const activity = (id: string, organizationId = ORG) =>
    storage.listActivity(id, organizationId);

  /** Resolves once some query in this database is blocked on a lock. */
  const untilABackendWaitsOnALock = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows } = await sql<{ waiting: number }>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `.execute(database.db);
      if ((rows[0]?.waiting ?? 0) > 0) return;
      await sleep(20);
    }
    throw new Error("no query ever waited on a lock");
  };

  const statusOf = async (id: string) =>
    (
      await database.db
        .selectFrom("task_board_items")
        .select(["status"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).status;

  it("closes a reports card still in triage and records the move and the finding", async () => {
    const card = await reportsCard();
    expect(card.status).toBe("triage");

    const result = await resolve(card.id);
    expect(result.outcome).toBe("closed");
    expect(result.replayed).toBe(false);
    expect(result.item?.status).toBe("done");

    const row = await database.db
      .selectFrom("task_board_items")
      .select(["status", "updated_by"])
      .where("id", "=", card.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "done", updated_by: "system" });

    const entries = await activity(card.id);
    expect(
      entries.map(({ action, actorId, data }) => ({ action, actorId, data })),
    ).toEqual(
      expect.arrayContaining([
        {
          action: "finding_resolved",
          actorId: null,
          data: { url: SOURCE.url, run_id: SOURCE.runId, closed: true },
        },
        {
          action: "status_changed",
          actorId: null,
          data: { from: "triage", to: "done", reason: "finding_resolved" },
        },
      ]),
    );
    expect(entries).toHaveLength(2);
  });

  // To Do counts as started, since it is the queue the Super Agent claims from.
  it.each(["todo", "in_progress", "in_review", "done", "archived"])(
    "only notes a reports card in %s",
    async (status) => {
      const card = await reportsCard(status);

      const result = await resolve(card.id);
      expect(result.outcome).toBe("noted");
      expect(result.item?.status).toBe(status);
      expect(await statusOf(card.id)).toBe(status);

      const entries = await activity(card.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe("finding_resolved");
      expect(entries[0]?.data).toEqual({
        url: SOURCE.url,
        run_id: SOURCE.runId,
        closed: false,
      });
    },
  );

  it("only notes a member's card, even in triage", async () => {
    const card = await storage.create({
      organizationId: ORG,
      title: "Speed up the home page",
      by: MEMBER,
    });

    const result = await resolve(card.id);
    expect(result.outcome).toBe("noted");
    expect(await statusOf(card.id)).toBe("triage");
    expect((await activity(card.id)).map((e) => e.action)).toEqual([
      "finding_resolved",
    ]);
  });

  it("skips a dismissed card and writes nothing", async () => {
    const card = await reportsCard();
    await storage.delete(card.id, ORG, MEMBER);

    const result = await resolve(card.id);
    expect(result).toEqual({ outcome: "skipped", replayed: false, item: null });
    expect(await statusOf(card.id)).toBe("triage");
    expect(await activity(card.id)).toHaveLength(0);
  });

  it("does not find another org's card, and leaves it untouched", async () => {
    const card = await reportsCard(undefined, OTHER_ORG);

    const result = await resolve(card.id);
    expect(result).toEqual({
      outcome: "not_found",
      replayed: false,
      item: null,
    });
    expect(await statusOf(card.id)).toBe("triage");
    expect(await activity(card.id, OTHER_ORG)).toHaveLength(0);
  });

  it("does not find a deleted card, an unknown id, or a Jira run's anchor", async () => {
    const deleted = await storage.create({
      organizationId: ORG,
      title: "Deleted by a member",
      by: MEMBER,
    });
    await storage.delete(deleted.id, ORG, MEMBER);
    const anchor = await storage.create({
      organizationId: ORG,
      title: "SHOP-1",
      status: "in_progress",
      source: "jira",
      by: MEMBER,
    });

    for (const id of [deleted.id, "board_does_not_exist", anchor.id]) {
      expect((await resolve(id)).outcome).toBe("not_found");
    }
    expect(await activity(anchor.id)).toHaveLength(0);
  });

  it("a replayed run id writes nothing and returns the first call's outcome", async () => {
    const closed = await reportsCard();
    const noted = await reportsCard("in_progress");
    expect((await resolve(closed.id)).outcome).toBe("closed");
    expect((await resolve(noted.id)).outcome).toBe("noted");

    expect(await resolve(closed.id)).toEqual({
      outcome: "closed",
      replayed: true,
      item: null,
    });
    expect(await resolve(noted.id)).toEqual({
      outcome: "noted",
      replayed: true,
      item: null,
    });
    expect(await activity(closed.id)).toHaveLength(2);
    expect(await activity(noted.id)).toHaveLength(1);
  });

  it("a later run id adds its own note but does not move the card again", async () => {
    const card = await reportsCard();
    expect((await resolve(card.id, "run_1")).outcome).toBe("closed");

    const later = await resolve(card.id, "run_2");
    expect(later.outcome).toBe("noted");
    expect(later.replayed).toBe(false);
    const notes = (await activity(card.id)).filter(
      (e) => e.action === "finding_resolved",
    );
    expect(notes.map((e) => e.data)).toEqual(
      expect.arrayContaining([
        { url: SOURCE.url, run_id: "run_1", closed: true },
        { url: SOURCE.url, run_id: "run_2", closed: false },
      ]),
    );
    expect(notes).toHaveLength(2);
  });

  it("a replay racing the first call waits for its commit, then writes nothing", async () => {
    const card = await reportsCard();
    let wrote = () => {};
    let release = () => {};
    const firstWrote = new Promise<void>((done) => (wrote = done));
    const released = new Promise<void>((done) => (release = done));

    // The first call runs in a transaction held open after it returns, so its
    // row lock and its entries stay uncommitted until `release`.
    const first = database.db.transaction().execute(async (trx) => {
      const result = await new TaskBoardStorage(trx).resolveFinding({
        id: card.id,
        organizationId: ORG,
        url: SOURCE.url,
        runId: SOURCE.runId,
      });
      wrote();
      await released;
      return result;
    });
    await firstWrote;
    const second = resolve(card.id);
    await untilABackendWaitsOnALock();
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ outcome: "closed", replayed: false });
    expect(b).toEqual({ outcome: "closed", replayed: true, item: null });
    expect((await activity(card.id)).map((e) => e.action).sort()).toEqual([
      "finding_resolved",
      "status_changed",
    ]);
  });

  it("tells the card's followers about a close, and not about a note", async () => {
    const notifications = new NotificationStorage(database.db);
    const closed = await reportsCard();
    const noted = await reportsCard("in_progress");
    for (const card of [closed, noted]) {
      await notifications.setSubscribed(MEMBER, card.id, true);
      await resolve(card.id);
    }

    const rows = await database.db
      .selectFrom("notifications")
      .select(["task_board_item_id", "type", "user_id"])
      .execute();
    expect(rows).toEqual([
      {
        task_board_item_id: closed.id,
        type: "status_changed",
        user_id: MEMBER,
      },
    ]);
  });
});
