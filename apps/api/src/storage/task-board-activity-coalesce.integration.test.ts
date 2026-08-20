import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { TaskBoardStorage } from "./task-board";

/**
 * Real-Postgres coverage for the prose-edit coalescing in `recordActivities`.
 *
 * The dialog autosaves while you type, so the timeline used to fill with
 * identical "updated the description" entries. What's under test is the
 * correlated UPDATE that moves the existing entry instead — Postgres
 * semantics, not something a fake would prove.
 */
const ORG = "org_coalesce";
const USER = "user_coalesce";
const OTHER_USER = "user_coalesce_2";
const TASK = "board_coalesce";

describe("TaskBoardStorage — activity coalescing", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  const listActions = async () =>
    (await storage.listActivity(TASK, ORG)).map((a) => a.action);

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const createdAt = new Date().toISOString();
    for (const id of [USER, OTHER_USER]) {
      await sql`
        INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
        VALUES (${id}, ${`${id}@test.com`}, false, 'Coalesce', ${createdAt}, ${createdAt})
      `.execute(database.db);
    }
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "coalesce-org", createdAt })
      .execute();
    storage = new TaskBoardStorage(database.db);
    // `create` writes no activity of its own; the tool layer logs "created".
    await storage.create({ organizationId: ORG, title: "Task", by: USER });
    // The card the entries hang off; `create` minted its own id.
    await database.db
      .updateTable("task_board_items")
      .set({ id: TASK })
      .where("organization_id", "=", ORG)
      .execute();
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const record = (
    action: "description_changed" | "status_changed",
    by = USER,
  ) =>
    storage.recordActivities([{ taskBoardItemId: TASK, action, actorId: by }]);

  it("keeps one entry for a burst of description edits", async () => {
    for (let i = 0; i < 5; i++) await record("description_changed");
    expect(await listActions()).toEqual(["description_changed"]);
  });

  it("moves the coalesced entry forward in time", async () => {
    const before = (await storage.listActivity(TASK, ORG)).at(-1)!.occurredAt;
    await record("description_changed");
    const after = (await storage.listActivity(TASK, ORG)).at(-1)!.occurredAt;
    expect(Date.parse(after)).toBeGreaterThanOrEqual(Date.parse(before));
  });

  it("does not coalesce another actor's edit onto yours", async () => {
    await record("description_changed", OTHER_USER);
    expect(await listActions()).toEqual([
      "description_changed",
      "description_changed",
    ]);
  });

  it("leaves every other action alone", async () => {
    await record("status_changed");
    await record("status_changed");
    const actions = await listActions();
    expect(actions.filter((a) => a === "status_changed")).toHaveLength(2);
  });
});
