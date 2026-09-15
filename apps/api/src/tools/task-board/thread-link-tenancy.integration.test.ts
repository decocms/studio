import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { TaskBoardStorage } from "../../storage/task-board";
import {
  OrgScopedThreadStorage,
  SqlThreadStorage,
} from "../../storage/threads";
import { TASK_BOARD_ITEM_UPDATE } from "./update";

const ORG_A = "org_thread_link_a";
const ORG_B = "org_thread_link_b";
const USER_A = "user_thread_link_a";
const USER_B = "user_thread_link_b";

describe("task board thread-link tenancy (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let rawThreads: SqlThreadStorage;
  let ctx: StudioContext;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values([
        { id: ORG_A, name: ORG_A, slug: ORG_A, createdAt: now },
        { id: ORG_B, name: ORG_B, slug: ORG_B, createdAt: now },
      ])
      .execute();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES
        (${USER_A}, ${`${USER_A}@test.com`}, false, ${USER_A}, ${now}, ${now}),
        (${USER_B}, ${`${USER_B}@test.com`}, false, ${USER_B}, ${now}, ${now})
    `.execute(database.db);

    taskBoard = new TaskBoardStorage(database.db);
    rawThreads = new SqlThreadStorage(database.db);
    ctx = {
      auth: {
        user: { id: USER_A, email: `${USER_A}@test.com`, name: USER_A },
      },
      organization: { id: ORG_A, slug: ORG_A, name: ORG_A },
      storage: {
        taskBoard,
        threads: new OrgScopedThreadStorage(rawThreads, ORG_A),
      },
      access: {
        granted: () => true,
        check: async () => {},
        grant: () => {},
        setToolName: () => {},
      },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("rejects a foreign thread before linking it through the update tool", async () => {
    const task = await taskBoard.create({
      organizationId: ORG_A,
      title: "Organization A task",
      by: USER_A,
    });
    const foreignThread = await rawThreads.create({
      organization_id: ORG_B,
      title: "Organization B secret thread",
      created_by: USER_B,
      message_storage_version: 2,
    });

    await expect(
      TASK_BOARD_ITEM_UPDATE.handler(
        { id: task.id, linkThreadId: foreignThread.id },
        ctx,
      ),
    ).rejects.toThrow(`Thread not found: ${foreignThread.id}`);

    const links = await database.db
      .selectFrom("task_board_item_threads")
      .selectAll()
      .where("task_board_item_id", "=", task.id)
      .execute();
    expect(links).toEqual([]);
    expect((await taskBoard.getById(task.id, ORG_A))?.threads).toEqual([]);
  });

  it("links a same-organization thread and keeps the operation idempotent", async () => {
    const task = await taskBoard.create({
      organizationId: ORG_A,
      title: "Same-organization task",
      by: USER_A,
    });
    const thread = await rawThreads.create({
      organization_id: ORG_A,
      title: "Same-organization thread",
      created_by: USER_A,
      message_storage_version: 2,
    });

    await TASK_BOARD_ITEM_UPDATE.handler(
      { id: task.id, linkThreadId: thread.id },
      ctx,
    );
    const result = await TASK_BOARD_ITEM_UPDATE.handler(
      { id: task.id, linkThreadId: thread.id },
      ctx,
    );

    expect(result.item.threads).toHaveLength(1);
    expect(result.item.threads[0]?.threadId).toBe(thread.id);
    expect(result.item.threads[0]?.title).toBe("Same-organization thread");
  });

  it("blocks mismatched storage writes and hides malformed legacy links", async () => {
    const task = await taskBoard.create({
      organizationId: ORG_A,
      title: "Storage boundary task",
      by: USER_A,
    });
    const foreignThread = await rawThreads.create({
      organization_id: ORG_B,
      title: "Foreign fields must stay hidden",
      created_by: USER_B,
      message_storage_version: 2,
    });

    await taskBoard.linkThread(task.id, foreignThread.id, ORG_A);
    expect(
      await database.db
        .selectFrom("task_board_item_threads")
        .select("thread_id")
        .where("task_board_item_id", "=", task.id)
        .execute(),
    ).toEqual([]);

    // Older code could persist this inconsistent row. Read-side scoping keeps
    // its foreign thread fields out of current board responses.
    await database.db
      .insertInto("task_board_item_threads")
      .values({
        task_board_item_id: task.id,
        thread_id: foreignThread.id,
        organization_id: ORG_A,
      })
      .execute();

    expect((await taskBoard.getById(task.id, ORG_A))?.threads).toEqual([]);
    const listed = (await taskBoard.list(ORG_A)).find(
      (item) => item.id === task.id,
    );
    expect(listed?.threads).toEqual([]);
  });
});
