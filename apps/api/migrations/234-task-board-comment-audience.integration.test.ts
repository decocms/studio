/**
 * Migration 234 hides the handoff agents already wrote and nothing else.
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
import { up as up234 } from "./234-task-board-comment-audience";

describe("migration 234 — task comment audience", () => {
  let database: StudioDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("marks existing agent comments internal and keeps people's comments human", async () => {
    const storage = new TaskBoardStorage(database.db);
    const item = await storage.create({
      organizationId: "org_test",
      title: "Task from before the migration",
      by: "user_test",
    });
    await sql`alter table task_board_comments drop column audience`.execute(
      database.db,
    );
    await sql`
      insert into task_board_comments (id, task_board_item_id, author_id, thread_id, body)
      values
        ('cmt_agent', ${item.id}, 'super-agent', 'thrd_run', 'handoff'),
        ('cmt_person', ${item.id}, 'user_test', null, 'question')
    `.execute(database.db);

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up234(database.db as any);

    const comments = await storage.listComments(item.id, "org_test");
    expect(Object.fromEntries(comments.map((c) => [c.id, c.audience]))).toEqual(
      { cmt_agent: "internal", cmt_person: "human" },
    );
  });
});
