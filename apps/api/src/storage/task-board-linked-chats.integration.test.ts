/**
 * Real-Postgres coverage for the built-in "Move cards from linked chats": on
 * (the default), a run on any thread linked to a card moves it as before; off,
 * only the Implementer's run does, and a failed linked thread is still
 * relabeled once the card delivered.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioContext } from "../core/studio-context";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { ensureBuiltinAutomations } from "../automations/builtin";
import {
  openReviewCycleForRun,
  reactToFailedTaskRun,
} from "../tools/task-board/run-reactions";
import { createAutomationsStorage } from "./automations";
import { TaskBoardStorage } from "./task-board";
import { SqlThreadStorage } from "./threads";

const ORG = "org_linked_chats";
const USER = "user_linked_chats";

describe("Move cards from linked chats (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let threads: SqlThreadStorage;
  let implementerTriggerId: string;

  const setLinkedChats = (active: boolean) =>
    sql`update automations set active = ${active}
         where organization_id = ${ORG} and system_key = 'linked_chats'`.execute(
      database.db,
    );

  /** A card with one message-carrying thread linked: a chat, or the
   *  Implementer's run when `implementer` is set. */
  const cardWithThread = async (
    title: string,
    opts: {
      status: "in_progress" | "in_review";
      thread: "completed" | "failed" | "in_progress";
      implementer?: boolean;
    },
  ) => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title,
      status: opts.status,
      by: USER,
    });
    const thread = await threads.create({
      organization_id: ORG,
      title: "chat",
      status: opts.thread,
      message_storage_version: 2,
      created_by: USER,
      ...(opts.implementer ? { trigger_id: implementerTriggerId } : {}),
    });
    await taskBoard.linkThread(task.id, thread.id, ORG);
    await database.db
      .insertInto("thread_message_parts")
      .values({
        id: `${thread.id}:m:0`,
        seq: 0,
        org_id: ORG,
        thread_id: thread.id,
        run_id: thread.id,
        message_id: `${thread.id}:m`,
        role: "user",
        kind: "text",
        payload: JSON.stringify({ type: "text", text: "go" }),
        created_at: new Date().toISOString(),
      })
      .execute();
    return { task, thread };
  };

  const statusOf = async (taskId: string) =>
    (await taskBoard.getById(taskId, ORG))?.status;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "org-linked-chats", createdAt: now })
      .execute();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"linked@chats.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    threads = new SqlThreadStorage(database.db);
    await ensureBuiltinAutomations(database.db, { id: ORG, createdBy: USER });
    const implementer = await createAutomationsStorage(
      database.db,
    ).findBuiltinTrigger(ORG, "implementer");
    implementerTriggerId = implementer!.triggerId;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("on: a linked chat that finishes moves its card on, as before", async () => {
    await setLinkedChats(true);
    const { task, thread } = await cardWithThread("chat, on", {
      status: "in_progress",
      thread: "completed",
    });

    await taskBoard.advanceLinkedTasksToReviewOnThreadFinish(thread.id, ORG);

    expect(await statusOf(task.id)).toBe("qa");
  });

  it("off: a linked chat that finishes leaves its card; the Implementer's run still moves it", async () => {
    await setLinkedChats(false);
    const chat = await cardWithThread("chat, off", {
      status: "in_progress",
      thread: "completed",
    });
    const run = await cardWithThread("implementer, off", {
      status: "in_progress",
      thread: "completed",
      implementer: true,
    });

    await taskBoard.advanceLinkedTasksToReviewOnThreadFinish(
      chat.thread.id,
      ORG,
    );
    await taskBoard.advanceLinkedTasksToReviewOnThreadFinish(
      run.thread.id,
      ORG,
    );

    expect(await statusOf(chat.task.id)).toBe("in_progress");
    expect(await statusOf(run.task.id)).toBe("qa");
  });

  it("off: a linked chat running under review leaves the card In Review", async () => {
    await setLinkedChats(false);
    const chat = await cardWithThread("chatted under review", {
      status: "in_review",
      thread: "in_progress",
    });
    const run = await cardWithThread("re-prompted under review", {
      status: "in_review",
      thread: "in_progress",
      implementer: true,
    });

    expect(
      await taskBoard.reopenLinkedTasksOnThreadRun(chat.thread.id, ORG),
    ).toEqual([]);
    await taskBoard.reopenLinkedTasksOnThreadRun(run.thread.id, ORG);

    expect(await statusOf(chat.task.id)).toBe("in_review");
    expect(await statusOf(run.task.id)).toBe("in_progress");
  });

  it("off: a pull request a linked chat opens starts no review", async () => {
    await setLinkedChats(false);
    const { task, thread } = await cardWithThread("chat opens a PR", {
      status: "in_progress",
      thread: "in_progress",
    });
    const ctx = {
      organization: { id: ORG },
      metadata: {},
      storage: { taskBoard },
    } as unknown as StudioContext;

    await openReviewCycleForRun(ctx, thread.id);

    const after = await taskBoard.getById(task.id, ORG);
    expect(after?.status).toBe("in_progress");
    expect(after?.reviewCycleStartedAt).toBeNull();

    await setLinkedChats(true);
    await openReviewCycleForRun(ctx, thread.id);
    expect(await statusOf(task.id)).toBe("in_review");
  });

  it("off: a failed linked chat is not retried, and is still relabeled once the card delivered", async () => {
    await setLinkedChats(false);
    const working = await cardWithThread("failed chat", {
      status: "in_progress",
      thread: "failed",
    });
    const delivered = await cardWithThread("failed after delivery", {
      status: "in_review",
      thread: "failed",
    });
    for (const { thread } of [working, delivered]) {
      await database.db
        .updateTable("threads")
        .set({ failure_kind: "error" })
        .where("id", "=", thread.id)
        .execute();
      await reactToFailedTaskRun(taskBoard, thread.id, ORG);
    }

    expect((await taskBoard.getById(working.task.id, ORG))?.retryAttempts).toBe(
      0,
    );
    const relabeled = await database.db
      .selectFrom("threads")
      .select("failure_kind")
      .where("id", "=", delivered.thread.id)
      .executeTakeFirstOrThrow();
    expect(relabeled.failure_kind).toBe("ended_after_delivery");
  });

  it("on: a failed linked chat is retried, as before", async () => {
    await setLinkedChats(true);
    const { task, thread } = await cardWithThread("failed chat, on", {
      status: "in_progress",
      thread: "failed",
    });
    await database.db
      .updateTable("threads")
      .set({ failure_kind: "error" })
      .where("id", "=", thread.id)
      .execute();

    await reactToFailedTaskRun(taskBoard, thread.id, ORG);

    expect((await taskBoard.getById(task.id, ORG))?.retryAttempts).toBe(1);
  });
});
