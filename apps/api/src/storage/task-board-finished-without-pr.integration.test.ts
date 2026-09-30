/**
 * Real-Postgres coverage for `listItemsFinishedWithoutPr` — the sweeper's list
 * of cards whose run finished In Progress with no PR linked. A `claude-code`
 * run opens its PR inside the pod where no Studio hook sees it, and nothing
 * else visits these cards, so every predicate here decides whether one is
 * rescued or stays In Progress for good.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { TaskBoardStorage } from "./task-board";
import { SqlThreadStorage } from "./threads";
import type { ThreadStatus } from "@decocms/shared/entities";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

const ORG = "org_finished_no_pr";
const USER = "user_finished_no_pr";

describe("listItemsFinishedWithoutPr (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let threads: SqlThreadStorage;

  const card = (title: string, assigneeId: string = SUPER_AGENT_ASSIGNEE_ID) =>
    taskBoard.create({
      organizationId: ORG,
      title,
      status: "in_progress",
      assigneeId,
      repo: "acme/shop",
      by: USER,
    });

  const run = async (taskId: string, status: ThreadStatus, at: string) => {
    const thread = await threads.create({
      organization_id: ORG,
      title: "Super Agent: run",
      status,
      message_storage_version: 2,
      created_by: USER,
    });
    await database.db
      .updateTable("threads")
      .set({ updated_at: at })
      .where("id", "=", thread.id)
      .execute();
    await taskBoard.linkThread(taskId, thread.id, ORG);
    return thread.id;
  };

  const setItem = (
    id: string,
    values: {
      review_cycle_started_at?: string;
      dismissed_at?: string;
      last_swept_at?: string;
      source?: "jira";
    },
  ) =>
    database.db
      .updateTable("task_board_items")
      .set(values)
      .where("id", "=", id)
      .execute();

  const list = async () =>
    (await taskBoard.listItemsFinishedWithoutPr(50, new Date())).map(
      (r) => r.id,
    );

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-finished-no-pr",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"finished-no-pr@test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    threads = new SqlThreadStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("returns a card whose newest run completed with nothing linked, stamped with when it ended", async () => {
    const task = await card("finished, PR unseen");
    await run(task.id, "failed", "2026-01-01T09:00:00Z");
    await run(task.id, "completed", "2026-01-01T10:00:00Z");

    const found = (
      await taskBoard.listItemsFinishedWithoutPr(50, new Date())
    ).find((r) => r.id === task.id);
    expect(found?.organizationId).toBe(ORG);
    expect(found?.finishedAt.toISOString()).toBe("2026-01-01T10:00:00.000Z");
  });

  it("skips a card whose PR is already linked", async () => {
    const task = await card("linked");
    await run(task.id, "completed", "2026-01-01T10:00:00Z");
    await taskBoard.linkPr({
      taskBoardItemId: task.id,
      organizationId: ORG,
      url: "https://github.com/acme/shop/pull/1",
      prNumber: 1,
      repo: { provider: "github", host: "github.com", path: "acme/shop" },
    });
    expect(await list()).not.toContain(task.id);
  });

  it("skips a card already in its review cycle", async () => {
    const task = await card("under review");
    await run(task.id, "completed", "2026-01-01T10:00:00Z");
    await setItem(task.id, {
      review_cycle_started_at: new Date().toISOString(),
    });
    expect(await list()).not.toContain(task.id);
  });

  it("skips a card with a run still going, even behind a completed one", async () => {
    const task = await card("still running");
    await run(task.id, "in_progress", "2026-01-01T09:00:00Z");
    await run(task.id, "completed", "2026-01-01T10:00:00Z");
    expect(await list()).not.toContain(task.id);
  });

  it("leaves a card whose newest run failed to the failure reaction", async () => {
    const task = await card("newest failed");
    await run(task.id, "completed", "2026-01-01T09:00:00Z");
    await run(task.id, "failed", "2026-01-01T10:00:00Z");
    expect(await list()).not.toContain(task.id);
  });

  it("skips a card with no runs at all", async () => {
    const task = await card("never ran");
    expect(await list()).not.toContain(task.id);
  });

  it("skips a card a person has taken over, or dismissed, or a Jira anchor", async () => {
    const human = await card("taken over", USER);
    await run(human.id, "completed", "2026-01-01T10:00:00Z");
    const dismissed = await card("dismissed");
    await run(dismissed.id, "completed", "2026-01-01T10:00:00Z");
    await setItem(dismissed.id, { dismissed_at: new Date().toISOString() });
    const anchor = await card("jira anchor");
    await run(anchor.id, "completed", "2026-01-01T10:00:00Z");
    await setItem(anchor.id, { source: "jira" });

    const ids = await list();
    expect(ids).not.toContain(human.id);
    expect(ids).not.toContain(dismissed.id);
    expect(ids).not.toContain(anchor.id);
  });

  it("skips a card swept inside the interval, returning it once that passes", async () => {
    const task = await card("recently swept");
    await run(task.id, "completed", "2026-01-01T10:00:00Z");
    await setItem(task.id, { last_swept_at: "2026-01-01T11:00:00Z" });

    const due = (before: string) =>
      taskBoard
        .listItemsFinishedWithoutPr(50, new Date(before))
        .then((rows) => rows.map((r) => r.id));
    expect(await due("2026-01-01T10:59:00Z")).not.toContain(task.id);
    expect(await due("2026-01-01T11:01:00Z")).toContain(task.id);
  });
});
