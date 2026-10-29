import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sleep } from "@decocms/shared/std";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { DemoBoardStorage } from "./demo-board";
import { OrganizationSettingsStorage } from "./organization-settings";
import { TaskBoardStorage } from "./task-board";

const ORG = "org_test";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("DemoBoardStorage", () => {
  let database: StudioDatabase;
  let board: TaskBoardStorage;
  let demo: DemoBoardStorage;

  const insertThread = async (
    id: string,
    status: "completed" | "in_progress",
    at: Date,
  ) => {
    await database.db
      .insertInto("threads")
      .values({
        id,
        organization_id: ORG,
        title: id,
        status,
        virtual_mcp_id: "",
        metadata: JSON.stringify({ source: "test" }),
        created_at: at.toISOString(),
        updated_at: at.toISOString(),
        created_by: "user_1",
      })
      .execute();
  };
  const linkThread = (itemId: string, threadId: string) =>
    database.db
      .insertInto("task_board_item_threads")
      .values({
        task_board_item_id: itemId,
        thread_id: threadId,
        organization_id: ORG,
      })
      .execute();
  const linkPr = (itemId: string, prNumber: number) =>
    database.db
      .insertInto("task_board_item_prs")
      .values({
        task_board_item_id: itemId,
        organization_id: ORG,
        url: `https://github.com/acme/shop/pull/${prNumber}`,
        pr_number: prNumber,
        repo_owner: "acme",
        repo_name: "shop",
      })
      .execute();
  const statusOf = async (id: string) =>
    (
      await database.db
        .selectFrom("task_board_items")
        .select("status")
        .where("id", "=", id)
        .executeTakeFirst()
    )?.status;
  const threadExists = async (id: string) =>
    !!(await database.db
      .selectFrom("threads")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst());

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    board = new TaskBoardStorage(database.db);
    demo = new DemoBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("returns the board to its capture, a day later", async () => {
    const before = new Date(Date.now() - DAY_MS);
    const frozen = await board.create({
      organizationId: ORG,
      title: "Frozen",
      status: "qa",
      by: "user_1",
    });
    const live = await board.create({
      organizationId: ORG,
      title: "Live",
      status: "todo",
      by: "user_1",
    });
    const archived = await board.create({
      organizationId: ORG,
      title: "Archived",
      status: "archived",
      by: "user_1",
    });
    await insertThread("thrd_frozen_run", "completed", before);
    await linkThread(frozen.id, "thrd_frozen_run");
    await database.db
      .insertInto("thread_message_parts")
      .values({
        id: "run_1:msg_1:0",
        seq: 0,
        org_id: ORG,
        thread_id: "thrd_frozen_run",
        run_id: "run_1",
        message_id: "msg_1",
        role: "assistant",
        kind: "text",
        payload: JSON.stringify({ text: "Shipped the new top bar." }),
        metadata: JSON.stringify({ usage: { cost: 0.5 } }),
        created_at: before.toISOString(),
      })
      .execute();
    await board.createComment({
      taskBoardItemId: frozen.id,
      organizationId: ORG,
      authorId: "user_1",
      body: "![shot](/api/org_test/fs/outputs/read?path=a.png)",
    });
    await linkPr(frozen.id, 1);
    await insertThread("thrd_old_chat", "completed", before);

    const snapshot = await demo.capture(ORG, {
      liveItemIds: [live.id],
      capturedBy: "user_1",
      readPrCards: async () => [],
    });
    expect(snapshot.archivedItemIds).toEqual([archived.id]);
    await sleep(5);

    // A demo happens: cards move, a live card runs, new work shows up.
    await board.update(frozen.id, ORG, { status: "done" }, "user_1");
    await board.createComment({
      taskBoardItemId: frozen.id,
      organizationId: ORG,
      authorId: "user_1",
      body: "nice",
    });
    await insertThread("thrd_live_run", "in_progress", new Date());
    await linkThread(live.id, "thrd_live_run");
    await linkPr(live.id, 2);
    await board.update(archived.id, ORG, { status: "todo" }, "user_1");
    await linkPr(archived.id, 3);
    const added = await board.create({
      organizationId: ORG,
      title: "Added mid-demo",
      by: "user_1",
    });
    await insertThread("thrd_new_chat", "completed", new Date());

    const now = new Date(Date.parse(snapshot.capturedAt) + DAY_MS);
    const restored = await demo.restore(ORG, now);

    expect(restored?.deletedItemIds).toEqual([added.id]);
    expect(restored?.rearchivedItemIds).toEqual([archived.id]);
    expect(restored?.prsToClose.map((pr) => pr.number)).toEqual([2, 3]);
    expect(await board.listPrs(archived.id, ORG)).toHaveLength(0);
    expect(await statusOf(frozen.id)).toBe("qa");
    expect(await statusOf(live.id)).toBe("todo");
    expect(await statusOf(archived.id)).toBe("archived");
    expect(await statusOf(added.id)).toBeUndefined();
    expect(await threadExists("thrd_live_run")).toBe(false);
    expect(await threadExists("thrd_new_chat")).toBe(false);
    expect(await threadExists("thrd_old_chat")).toBe(true);
    expect(await board.listComments(frozen.id, ORG)).toHaveLength(1);
    expect(await board.listPrs(live.id, ORG)).toHaveLength(0);

    const thread = await database.db
      .selectFrom("threads")
      .select(["created_at", "metadata"])
      .where("id", "=", "thrd_frozen_run")
      .executeTakeFirstOrThrow();
    expect(Date.parse(String(thread.created_at))).toBe(
      before.getTime() + (now.getTime() - Date.parse(snapshot.capturedAt)),
    );
    expect(thread.metadata).toEqual({ source: "test" });
    const part = await database.db
      .selectFrom("thread_message_parts")
      .select(["payload", "metadata"])
      .where("thread_id", "=", "thrd_frozen_run")
      .executeTakeFirstOrThrow();
    expect(part.payload).toEqual({ text: "Shipped the new top bar." });
    expect(part.metadata).toEqual({ usage: { cost: 0.5 } });

    // A second reset converges: nothing left to delete or close.
    const again = await demo.restore(ORG, now);
    expect(again?.deletedItemIds).toEqual([]);
    expect(again?.prsToClose).toEqual([]);
    expect(await threadExists("thrd_frozen_run")).toBe(true);
  });

  it("keeps the sweeps off frozen cards only while the reset is on", async () => {
    const settings = new OrganizationSettingsStorage(database.db);
    const inReview = await board.create({
      organizationId: ORG,
      title: "In review",
      status: "in_review",
      by: "user_1",
    });
    await demo.capture(ORG, {
      liveItemIds: [],
      capturedBy: "user_1",
      readPrCards: async () => [],
    });
    const swept = async () =>
      (await board.listItemsPendingReview(100)).map((row) => row.id);

    expect(await demo.frozenItemIds(ORG)).toEqual(new Set());
    expect(await swept()).toContain(inReview.id);

    await settings.upsert(ORG, { flags: { demo_board_reset: true } });
    expect((await demo.frozenItemIds(ORG)).has(inReview.id)).toBe(true);
    expect(await swept()).not.toContain(inReview.id);
    expect(await demo.frozenPrCards(ORG, inReview.id)).toEqual([]);
  });

  it("refuses to freeze a run that is still going", async () => {
    const card = await board.create({
      organizationId: ORG,
      title: "Running",
      by: "user_1",
    });
    await insertThread("thrd_running", "in_progress", new Date());
    await linkThread(card.id, "thrd_running");
    await expect(
      demo.capture(ORG, {
        liveItemIds: [],
        capturedBy: "user_1",
        readPrCards: async () => [],
      }),
    ).rejects.toThrow("thrd_running");
  });
});
