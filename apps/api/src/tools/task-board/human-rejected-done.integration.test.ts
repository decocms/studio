/** The gate is entirely SQL over `actor_id` and two jsonb keys — an in-memory fake
 *  would not reproduce it, so this runs against real Postgres. */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { TaskBoardStorage } from "../../storage/task-board";

const ORG = "org_rejectdone_1";
const OTHER_ORG = "org_rejectdone_2";
const USER = "user_rd1";

describe("hasHumanRejectedDone", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;

  const seed = async (): Promise<string> => {
    const item = await taskBoard.create({
      organizationId: ORG,
      title: `card-${Math.random()}`,
      status: "in_review",
      by: USER,
    });
    return item.id;
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values([
        { id: ORG, name: ORG, slug: "org-rejectdone-1", createdAt: now },
        {
          id: OTHER_ORG,
          name: OTHER_ORG,
          slug: "org-rejectdone-2",
          createdAt: now,
        },
      ])
      .execute();
    // Raw SQL: real Postgres has a BOOLEAN emailVerified the typed shape disagrees with.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"rd1@rejectdone.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("is false for a card nobody has pulled out of Done", async () => {
    const id = await seed();
    expect(await taskBoard.hasHumanRejectedDone(id, ORG)).toBe(false);
  });

  it("is true once a member moves the card out of Done", async () => {
    const id = await seed();
    await taskBoard.recordActivity({
      taskBoardItemId: id,
      action: "status_changed",
      actorId: USER,
      data: { from: "done", to: "in_review" },
    });
    expect(await taskBoard.hasHumanRejectedDone(id, ORG)).toBe(true);
  });

  it("ignores a machine move out of Done", async () => {
    const id = await seed();
    await taskBoard.recordActivity({
      taskBoardItemId: id,
      action: "status_changed",
      actorId: null,
      data: { from: "done", to: "in_progress" },
    });
    expect(await taskBoard.hasHumanRejectedDone(id, ORG)).toBe(false);
  });

  it("ignores a member's moves that don't leave Done", async () => {
    const id = await seed();
    await taskBoard.recordActivity({
      taskBoardItemId: id,
      action: "status_changed",
      actorId: USER,
      data: { from: "in_review", to: "done" },
    });
    await taskBoard.recordActivity({
      taskBoardItemId: id,
      action: "priority_changed",
      actorId: USER,
      data: { from: "done", to: "in_review" },
    });
    expect(await taskBoard.hasHumanRejectedDone(id, ORG)).toBe(false);
  });

  it("ignores Rerun on a Done card — that asks for more work, not a reopen", async () => {
    const id = await seed();
    await taskBoard.recordActivity({
      taskBoardItemId: id,
      action: "status_changed",
      actorId: USER,
      data: { from: "done", to: "in_progress", reason: "rerun" },
    });
    expect(await taskBoard.hasHumanRejectedDone(id, ORG)).toBe(false);
  });

  it("leaves an untouched card free to auto-complete", async () => {
    const id = await seed();
    await taskBoard.recordActivity({
      taskBoardItemId: id,
      action: "status_changed",
      actorId: null,
      data: { from: "in_progress", to: "in_review" },
    });
    await taskBoard.recordActivity({
      taskBoardItemId: id,
      action: "title_changed",
      actorId: USER,
      data: { from: "old", to: "new" },
    });
    expect(await taskBoard.hasHumanRejectedDone(id, ORG)).toBe(false);
  });

  it("stays true after the card is completed again", async () => {
    const id = await seed();
    await taskBoard.recordActivity({
      taskBoardItemId: id,
      action: "status_changed",
      actorId: USER,
      data: { from: "done", to: "in_review" },
    });
    await taskBoard.update(id, ORG, { status: "done" }, USER);
    expect(await taskBoard.hasHumanRejectedDone(id, ORG)).toBe(true);
  });

  it("does not leak across orgs", async () => {
    const id = await seed();
    await taskBoard.recordActivity({
      taskBoardItemId: id,
      action: "status_changed",
      actorId: USER,
      data: { from: "done", to: "in_review" },
    });
    expect(await taskBoard.hasHumanRejectedDone(id, OTHER_ORG)).toBe(false);
  });
});
