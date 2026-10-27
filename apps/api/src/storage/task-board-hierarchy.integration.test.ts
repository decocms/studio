import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  connectTestPgDatabase,
  closeTestPgDatabase,
} from "../database/test-db-pg";
import { TaskBoardHierarchyError, TaskBoardStorage } from "./task-board";

describe("task board epics and subtasks", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const otherOrgId = `org_${randomUUID()}`;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    storage = new TaskBoardStorage(database.db);
    const now = new Date().toISOString();
    await sql`INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${userId}, ${`${userId}@example.test`}, false, 'Hierarchy test', ${now}, ${now})`.execute(
      database.db,
    );
    for (const id of [orgId, otherOrgId]) {
      await database.db
        .insertInto("organization")
        .values({ id, name: "Hierarchy test", slug: id, createdAt: now })
        .execute();
    }
  });
  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const card = (title: string, extra: { isEpic?: boolean } = {}) =>
    storage.create({ organizationId: orgId, title, by: userId, ...extra });
  const parentOf = async (id: string) =>
    (await storage.getById(id, orgId))?.parentId;
  const setParent = (id: string, parentId: string | null) =>
    storage.update(id, orgId, { parentId }, userId);

  test("a new card is a top-level card", async () => {
    const item = await card("Plain");
    expect(item.parentId).toBeNull();
    expect(item.isEpic).toBe(false);
  });

  test("sets and clears a parent", async () => {
    const epic = await card("Epic", { isEpic: true });
    const work = await card("Work");
    const sub = await card("Sub");

    expect((await setParent(work.id, epic.id)).parentId).toBe(epic.id);
    expect((await setParent(sub.id, work.id)).parentId).toBe(work.id);
    expect((await storage.list(orgId)).find((i) => i.id === sub.id)).toEqual(
      expect.objectContaining({ parentId: work.id, isEpic: false }),
    );

    expect((await setParent(sub.id, null)).parentId).toBeNull();
    expect(await parentOf(sub.id)).toBeNull();
  });

  test("files a card under a parent at create", async () => {
    const epic = await card("Epic", { isEpic: true });
    const child = await storage.create({
      organizationId: orgId,
      title: "Child",
      parentId: epic.id,
      by: userId,
    });
    expect(child.parentId).toBe(epic.id);
  });

  test("rejects a parent from another organization", async () => {
    const foreign = await storage.create({
      organizationId: otherOrgId,
      title: "Foreign epic",
      isEpic: true,
      by: userId,
    });
    const item = await card("Local");
    await expect(setParent(item.id, foreign.id)).rejects.toThrow(
      TaskBoardHierarchyError,
    );
    await expect(
      storage.create({
        organizationId: orgId,
        title: "Local child",
        parentId: foreign.id,
        by: userId,
      }),
    ).rejects.toThrow(TaskBoardHierarchyError);
    expect(await parentOf(item.id)).toBeNull();
  });

  test("rejects self-parenting and cycles", async () => {
    const a = await card("A");
    const b = await card("B");
    await expect(setParent(a.id, a.id)).rejects.toThrow(
      TaskBoardHierarchyError,
    );

    await setParent(b.id, a.id);
    await expect(setParent(a.id, b.id)).rejects.toThrow(
      TaskBoardHierarchyError,
    );
    expect(await parentOf(a.id)).toBeNull();
  });

  test("nests three levels at most", async () => {
    const top = await card("Top");
    const sub = await card("Sub");
    const deeper = await card("Deeper");
    await setParent(sub.id, top.id);
    await expect(setParent(deeper.id, sub.id)).rejects.toThrow(
      "A subtask can't have subtasks of its own.",
    );

    // A card that has subtasks can't become a subtask itself.
    const other = await card("Other");
    await expect(setParent(top.id, other.id)).rejects.toThrow(
      "A card with subtasks can't become a subtask.",
    );
  });

  test("an epic takes no parent", async () => {
    const epic = await card("Epic", { isEpic: true });
    const other = await card("Other");
    await expect(setParent(epic.id, other.id)).rejects.toThrow(
      "An epic can't have a parent.",
    );
    await expect(
      storage.create({
        organizationId: orgId,
        title: "Nested epic",
        isEpic: true,
        parentId: other.id,
        by: userId,
      }),
    ).rejects.toThrow("An epic can't have a parent.");
  });

  test("making a card an epic lifts it out of its parent", async () => {
    const epic = await card("Epic", { isEpic: true });
    const item = await card("Item");
    await setParent(item.id, epic.id);
    const lifted = await storage.update(
      item.id,
      orgId,
      { isEpic: true },
      userId,
    );
    expect(lifted).toEqual(
      expect.objectContaining({ isEpic: true, parentId: null }),
    );
  });

  test("turning an epic back into a card releases its cards", async () => {
    const epic = await card("Epic", { isEpic: true });
    const work = await card("Work");
    const sub = await card("Sub");
    await setParent(work.id, epic.id);
    await setParent(sub.id, work.id);

    expect(await storage.childIds(epic.id, orgId)).toEqual([work.id]);
    await storage.update(epic.id, orgId, { isEpic: false }, userId);

    expect(await parentOf(work.id)).toBeNull();
    // The work item's own subtask stays with it, one level below the top.
    expect(await parentOf(sub.id)).toBe(work.id);
  });

  test("deleting a parent returns its children to the top level", async () => {
    const parent = await card("Parent");
    const child = await card("Child");
    await setParent(child.id, parent.id);

    expect(await storage.delete(parent.id, orgId, userId)).toBe(true);
    expect(await parentOf(child.id)).toBeNull();
  });

  test("dismissing a reports card releases its children", async () => {
    const finding = await storage.create({
      organizationId: orgId,
      title: "Finding",
      by: "system",
    });
    const child = await card("Child");
    await setParent(child.id, finding.id);

    await storage.delete(finding.id, orgId, userId);
    expect(await parentOf(child.id)).toBeNull();
    // A dismissed card can't take new children either.
    await expect(setParent(child.id, finding.id)).rejects.toThrow(
      TaskBoardHierarchyError,
    );
  });
});
