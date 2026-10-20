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
 * Real-Postgres coverage for where `update` puts a card that changes lane.
 * The slot is computed in SQL against the row's pre-update status, so an
 * in-memory fake would not exercise it.
 */
const ORG = "org_lane_order_1";
const OTHER_ORG = "org_lane_order_2";
const USER = "user_lane_order";

describe("TaskBoardStorage — lane change ordering", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const createdAt = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${`${USER}@test.com`}, false, 'Lane Order', ${createdAt}, ${createdAt})
    `.execute(database.db);
    for (const [id, slug] of [
      [ORG, "lane-order-one"],
      [OTHER_ORG, "lane-order-two"],
    ] as const) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug, createdAt })
        .execute();
    }
    storage = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const create = (organizationId: string, title: string, status: string) =>
    storage.create({ organizationId, title, status, by: USER });

  const laneTitles = async (organizationId: string, status: string) =>
    (await storage.list(organizationId))
      .filter((item) => item.status === status)
      .map((item) => item.title);

  it("moves a shipped card to the top of its new lane", async () => {
    await create(ORG, "Shipped earlier", "merged");
    await create(ORG, "Shipped last week", "merged");
    const shipping = await create(ORG, "Shipping now", "in_review");
    // A slot past every merged card: keeping it would sink the card.
    await storage.update(shipping.id, ORG, { sortOrder: 1000 }, USER);

    await storage.update(shipping.id, ORG, { status: "merged" }, USER);

    expect(await laneTitles(ORG, "merged")).toEqual([
      "Shipping now",
      "Shipped last week",
      "Shipped earlier",
    ]);
  });

  it("lands first in an empty lane", async () => {
    const card = await create(ORG, "Alone", "in_review");
    await storage.update(card.id, ORG, { sortOrder: 1000 }, USER);
    const moved = await storage.update(card.id, ORG, { status: "done" }, USER);
    expect(moved.status).toBe("done");
    expect(moved.sortOrder).toBe(-1);
  });

  it("keeps the slot when the status is unchanged", async () => {
    const card = await create(ORG, "Staying", "todo");
    await create(ORG, "Newer", "todo");
    const before = (await storage.getById(card.id, ORG))!.sortOrder;

    const after = await storage.update(card.id, ORG, { status: "todo" }, USER);

    expect(after.sortOrder).toBe(before);
    expect(await laneTitles(ORG, "todo")).toEqual(["Newer", "Staying"]);
  });

  it("honors an explicit sortOrder over the top-of-lane default", async () => {
    await create(ORG, "Top", "failed");
    const card = await create(ORG, "Dragged", "in_review");

    const moved = await storage.update(
      card.id,
      ORG,
      { status: "failed", sortOrder: 500 },
      USER,
    );

    expect(moved.sortOrder).toBe(500);
    expect(await laneTitles(ORG, "failed")).toEqual(["Top", "Dragged"]);
  });

  it("ignores another organization's cards in the target lane", async () => {
    const other = await create(OTHER_ORG, "Other org", "archived");
    await storage.update(other.id, OTHER_ORG, { sortOrder: -9000 }, USER);
    const card = await create(ORG, "Archiving", "in_review");
    await storage.update(card.id, ORG, { sortOrder: 1000 }, USER);

    const moved = await storage.update(
      card.id,
      ORG,
      { status: "archived" },
      USER,
    );

    expect(moved.sortOrder).toBe(-1);
  });
});
