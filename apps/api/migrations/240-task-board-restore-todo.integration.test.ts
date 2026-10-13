/**
 * Migration 240 puts back the To Do cards 238 moved, and only those.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { TaskBoardStorage } from "../src/storage/task-board";
import { up as up238 } from "./238-task-board-default-lanes";
import { up as up240 } from "./240-task-board-restore-todo";

const ORG = "org_test";

describe("migration 240 — restore To Do", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new TaskBoardStorage(database.db);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  async function card(status: string): Promise<string> {
    const item = await storage.create({
      organizationId: ORG,
      title: `card in ${status}`,
      by: "user_test",
    });
    await sql`update task_board_items set status = ${status} where id = ${item.id}`.execute(
      database.db,
    );
    return item.id;
  }

  // biome-ignore lint/suspicious/noExplicitAny: migrations accept the test Kysely instance
  const db = () => database.db as any;
  const status = async (id: string) => (await storage.getById(id, ORG))?.status;

  it("returns a card 238 moved to Backlog, and leaves one moved since", async () => {
    const untouched = await card("todo");
    const movedSince = await card("todo");
    const alwaysBacklog = await card("triage");
    await up238(db());
    await storage.update(
      movedSince,
      ORG,
      { status: "in_progress" },
      "user_test",
    );
    await storage.recordActivity({
      taskBoardItemId: movedSince,
      action: "status_changed",
      actorId: "user_test",
      data: { from: "triage", to: "in_progress" },
    });

    await up240(db());

    expect(await status(untouched)).toBe("todo");
    expect(await status(movedSince)).toBe("in_progress");
    expect(await status(alwaysBacklog)).toBe("triage");
    const entries = await storage.listActivity(untouched, ORG);
    expect(entries.at(-1)).toMatchObject({
      action: "status_changed",
      actorId: null,
      data: { from: "triage", to: "todo" },
    });
  });

  it("is a no-op on a second run", async () => {
    const id = await card("todo");
    await up238(db());
    await up240(db());
    await up240(db());
    expect(await status(id)).toBe("todo");
    const restores = (await storage.listActivity(id, ORG)).filter(
      (a) => (a.data as { to?: string } | null)?.to === "todo",
    );
    expect(restores).toHaveLength(1);
  });
});
