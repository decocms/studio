import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { connectTestPgDatabase, closeTestPgDatabase } from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { TaskBoardStorage } from "./task-board";
import { TagStorage } from "./tags";

let database: StudioDatabase;
let storage: TaskBoardStorage;
const org = `org_${randomUUID()}`;
const otherOrg = `org_${randomUUID()}`;
const sender = `user_${randomUUID()}`;
beforeAll(async () => {
  database = await connectTestPgDatabase();
  storage = new TaskBoardStorage(database.db);
  const now = new Date().toISOString();
  await sql`INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
    VALUES (${sender}, ${`${sender}@example.test`}, false, 'Feedback sender', ${now}, ${now})`.execute(database.db);
  for (const id of [org, otherOrg]) await database.db.insertInto("organization").values({ id, name: "Test organization", slug: id, createdAt: now }).execute();
});
afterAll(async () => { await closeTestPgDatabase(database); });

test("returns a nonmember author's name and atomically attaches the feedback tag", async () => {
  const tag = await new TagStorage(database.db).createTag(org, "feedback button");
  const item = await storage.create({ organizationId: org, title: "Feedback", by: sender, tagIds: [tag.id, tag.id] });
  const loaded = await storage.getById(item.id, org);
  expect(loaded?.createdBy).toBe(sender);
  expect(loaded?.createdByName).toBe("Feedback sender");
  expect(loaded?.tags.map((tag) => tag.name)).toEqual(["feedback button"]);
  expect(await storage.getById(item.id, otherOrg)).toBeNull();
});

test("rejects another organization's tag without leaving a card", async () => {
  const tag = await new TagStorage(database.db).createTag(otherOrg, "feedback button");
  await expect(storage.create({ organizationId: org, title: "Invalid tag", by: sender, tagIds: [tag.id] })).rejects.toThrow("Invalid task tags");
  expect((await storage.list(org)).some((item) => item.title === "Invalid tag")).toBe(false);
});
